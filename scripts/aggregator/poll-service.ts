import { performance } from "node:perf_hooks";
import { Buffer } from "node:buffer";
import { KeycloakOIDCAuth } from "../util.js";
import { config } from "../config.js";

interface Options {
  svcNames: string[];
  outputNames: string[];
  intervalMs: number;
  count: number;
  durationMs: number;
  runId: string;
  description: boolean;
}

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

function parseList(value: string | undefined, fallback: string): string[] {
  return (value ?? fallback)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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

function parseRowCount(body: string): number | null {
  try {
    const parsed = JSON.parse(body);
    const bindings = parsed?.results?.bindings;
    return Array.isArray(bindings) ? bindings.length : null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readOptions(): Options {
  const count = getArg("--count");
  const parsedCount = count ? Number(count) : Number.POSITIVE_INFINITY;
  if (count && (!Number.isFinite(parsedCount) || parsedCount < 1)) {
    throw new Error(`Invalid count: ${count}`);
  }

  const svcNames = parseList(getArg("--svc"), config.svcName);
  const outputNames = parseList(getArg("--output"), "result");
  if (svcNames.length === 0) throw new Error("At least one service must be provided");
  if (outputNames.length > 1 && outputNames.length !== svcNames.length) {
    throw new Error("--output must contain either one value or the same number of comma-separated values as --svc");
  }

  return {
    svcNames,
    outputNames,
    intervalMs: parseDurationMs(getArg("--interval"), 60_000),
    count: parsedCount,
    durationMs: parseDurationMs(getArg("--duration"), 0),
    runId: getArg("--run-id") ?? "manual",
    description: hasArg("--description"),
  };
}

function logMeasurement(event: Record<string, unknown>) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    ...event,
  }));
}

function outputForService(opts: Options, index: number): string {
  return opts.outputNames[index] ?? opts.outputNames[0];
}

async function pollEndpoint(
  umaFetch: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  opts: Options,
  svcName: string,
  outputName: string,
  endpoint: string,
  poll: number,
  roundStartedAt: string,
) {
  const requestStartedAt = new Date().toISOString();
  const started = performance.now();
  let status = 0;
  let responseBytes = 0;
  let rows: number | null = null;
  let jsonParseMs: number | null = null;
  let error: string | undefined;

  try {
    const response = await umaFetch(endpoint, {
      method: "GET",
      headers: opts.description
        ? { Accept: "text/turtle" }
        : { Accept: "application/sparql-results+json, application/json" },
    });
    status = response.status;

    const body = await response.text();
    responseBytes = Buffer.byteLength(body, "utf8");

    if (!opts.description) {
      const parseStarted = performance.now();
      rows = parseRowCount(body);
      jsonParseMs = Math.round((performance.now() - parseStarted) * 1000) / 1000;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  logMeasurement({
    run_id: opts.runId,
    stage: opts.description ? "service_description_read" : "t7",
    event: "poll_result",
    aggregator: config.aggregatorId,
    service: svcName,
    output: opts.description ? undefined : outputName,
    endpoint,
    poll,
    service_count: opts.svcNames.length,
    poll_interval_ms: opts.intervalMs,
    round_started_at: roundStartedAt,
    request_started_at: requestStartedAt,
    status,
    latency_ms: Math.round((performance.now() - started) * 1000) / 1000,
    response_bytes: responseBytes,
    rows,
    json_parse_ms: jsonParseMs,
    error,
  });
}

async function main() {
  const opts = readOptions();
  const stopAt = opts.durationMs > 0 ? Date.now() + opts.durationMs : Number.POSITIVE_INFINITY;

  console.error("=== Initializing Keycloak Authentication ===");
  const auth = new KeycloakOIDCAuth();
  await auth.init(config.idp, config.realm);
  await auth.login(
    config.patient1.username,
    config.patient1.password,
    config.clientId,
    config.clientSecret,
  );

  const umaFetch = auth.createUMAFetch();
  console.error(`Polling services: ${opts.svcNames.join(", ")}`);
  if (!opts.description) console.error(`Polling outputs: ${opts.outputNames.join(", ")}`);
  console.error(`Interval: ${opts.intervalMs}ms`);

  let poll = 0;
  while (poll < opts.count && Date.now() <= stopAt) {
    poll++;
    const roundStartedAt = new Date().toISOString();

    await Promise.all(opts.svcNames.map((svcName, index) => {
      const outputName = outputForService(opts, index);
      const serviceEndpoint = `${config.aggregatorServer}/${config.aggregatorId}/${svcName}`;
      const outputEndpoint = `${serviceEndpoint}/${outputName}`;
      const endpoint = opts.description ? serviceEndpoint : outputEndpoint;

      return pollEndpoint(umaFetch, opts, svcName, outputName, endpoint, poll, roundStartedAt);
    }));

    if (poll < opts.count && Date.now() + opts.intervalMs <= stopAt) {
      await sleep(opts.intervalMs);
    } else if (poll < opts.count && Date.now() <= stopAt) {
      await sleep(Math.max(0, stopAt - Date.now()));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
