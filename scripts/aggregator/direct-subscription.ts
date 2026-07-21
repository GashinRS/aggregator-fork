import { appendFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { KeycloakOIDCAuth } from "../util.js";
import { config } from "../config.js";

interface Options {
  source: string;
  user: string;
  password: string;
  metric: string;
  runId: string;
  durationMs: number;
  outFile?: string;
}

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

function parseDurationMs(value: string | undefined, fallbackMs: number): number {
  if (!value) return fallbackMs;

  const match = value.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)(ms|s|m|min)?$/);
  if (!match) throw new Error(`Invalid duration: ${value}`);

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`Invalid duration: ${value}`);

  const unit = match[2] ?? "ms";
  if (unit === "ms") return amount;
  if (unit === "s") return amount * 1000;
  if (unit === "m" || unit === "min") return amount * 60 * 1000;
  return amount;
}

function parseOptions(): Options {
  const source = getArg("--source") ?? process.env.SUBSCRIPTION_SOURCE;
  const user = getArg("--user") ?? process.env.SUBSCRIPTION_USER;
  const password = getArg("--password") ?? process.env.SUBSCRIPTION_PASSWORD ?? "pass";
  const metric = getArg("--metric") ?? process.env.SUBSCRIPTION_METRIC ?? "wear:wearable.bvp";
  const runId = getArg("--run-id") ?? process.env.RUN_ID ?? process.env.EVALUATION_RUN_ID ?? "manual";
  const durationMs = parseDurationMs(getArg("--duration") ?? process.env.SUBSCRIPTION_DURATION, 0);
  const outFile = getArg("--out") ?? process.env.SUBSCRIPTION_OUT;

  if (!source) throw new Error("Missing --source, for example --source https://10.10.223.11/kronky4/slices/data/query");
  if (!user) throw new Error("Missing --user, for example --user kronky4");

  return { source, user, password, metric, runId, durationMs, outFile };
}

function buildSubscription(metric: string): string {
  return `
subscription {
  saref_ObservationAdded {
    id
    saref_hasTimestamp
    saref_hasValue
    void_inDataset
    saref_observes @filter(if: "it==${metric}")
  }
}
`;
}

function writeMeasurement(outFile: string | undefined, measurement: Record<string, unknown>) {
  const line = JSON.stringify(measurement);
  console.log(line);
  if (outFile) appendFileSync(outFile, `${line}\n`);
}

function eventRows(parsed: unknown): unknown[] {
  const value = (parsed as { data?: { saref_ObservationAdded?: unknown } })?.data?.saref_ObservationAdded;
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

function newestTimestamp(rows: unknown[]): string | undefined {
  let newestMs = Number.NEGATIVE_INFINITY;
  let newest: string | undefined;

  for (const row of rows) {
    const candidate = (row as { saref_hasTimestamp?: unknown })?.saref_hasTimestamp;
    if (typeof candidate !== "string") continue;

    const ms = Date.parse(candidate);
    if (Number.isFinite(ms) && ms > newestMs) {
      newestMs = ms;
      newest = candidate;
    }
  }

  return newest;
}

function extractSseMessages(buffer: string): { messages: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const rest = parts.pop() ?? "";
  return { messages: parts, rest };
}

async function main() {
  const opts = parseOptions();
  const startedAt = performance.now();
  const auth = new KeycloakOIDCAuth();

  await auth.init(config.idp, config.realm);
  await auth.login(opts.user, opts.password, config.clientId, config.clientSecret);

  const query = buildSubscription(opts.metric);
  const fetchWithUma = auth.createUMAFetch();
  const abort = new AbortController();
  let timeout: NodeJS.Timeout | undefined;

  if (opts.durationMs > 0) {
    timeout = setTimeout(() => abort.abort(), opts.durationMs);
  }

  writeMeasurement(opts.outFile, {
    ts: new Date().toISOString(),
    run_id: opts.runId,
    stage: "direct_subscription",
    event: "subscription_started",
    source: opts.source,
    user: opts.user,
    metric: opts.metric,
    duration_ms: opts.durationMs,
  });

  try {
    const response = await fetchWithUma(opts.source, {
      method: "POST",
      headers: {
        "Accept": "text/event-stream",
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
      },
      body: JSON.stringify({ query }),
      signal: abort.signal,
    });

    writeMeasurement(opts.outFile, {
      ts: new Date().toISOString(),
      run_id: opts.runId,
      stage: "direct_subscription",
      event: "http_result",
      source: opts.source,
      status: response.status,
      ok: response.ok,
      content_type: response.headers.get("content-type"),
    });

    if (!response.ok || !response.body) {
      throw new Error(`Subscription request failed: ${response.status} ${response.statusText} ${await response.text()}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventCount = 0;
    let totalRows = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const extracted = extractSseMessages(buffer);
      buffer = extracted.rest;

      for (const message of extracted.messages) {
        const dataLines = message
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trimStart());

        if (dataLines.length === 0) continue;

        const data = dataLines.join("\n");
        eventCount++;

        let parsed: unknown;
        let rows: unknown[] = [];
        let parseError: string | undefined;

        try {
          parsed = JSON.parse(data);
          rows = eventRows(parsed);
          totalRows += rows.length;
        } catch (err) {
          parseError = err instanceof Error ? err.message : String(err);
        }

        writeMeasurement(opts.outFile, {
          ts: new Date().toISOString(),
          run_id: opts.runId,
          stage: "direct_subscription",
          event: "sse_event",
          source: opts.source,
          metric: opts.metric,
          sequence: eventCount,
          event_rows: rows.length,
          total_rows: totalRows,
          newest_observation_timestamp: newestTimestamp(rows),
          elapsed_ms: Math.round(performance.now() - startedAt),
          parse_error: parseError,
          response_bytes: Buffer.byteLength(data),
        });
      }
    }

    writeMeasurement(opts.outFile, {
      ts: new Date().toISOString(),
      run_id: opts.runId,
      stage: "direct_subscription",
      event: "subscription_ended",
      source: opts.source,
      metric: opts.metric,
      sse_events: eventCount,
      total_rows: totalRows,
      elapsed_ms: Math.round(performance.now() - startedAt),
    });
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") {
      writeMeasurement(opts.outFile, {
        ts: new Date().toISOString(),
        run_id: opts.runId,
        stage: "direct_subscription",
        event: "subscription_aborted",
        source: opts.source,
        metric: opts.metric,
        duration_ms: opts.durationMs,
        elapsed_ms: Math.round(performance.now() - startedAt),
      });
      return;
    }

    throw err;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

if (hasArg("--help")) {
  console.log(`
Usage:
  npm run direct-subscription -- \\
    --source https://10.10.223.11/kronky4/slices/data/query \\
    --user kronky4 \\
    --password pass \\
    --metric wear:wearable.bvp \\
    --duration 10m \\
    --out direct-subscription.jsonl

Environment alternatives:
  SUBSCRIPTION_SOURCE, SUBSCRIPTION_USER, SUBSCRIPTION_PASSWORD,
  SUBSCRIPTION_METRIC, SUBSCRIPTION_DURATION, SUBSCRIPTION_OUT, RUN_ID
`);
} else {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
