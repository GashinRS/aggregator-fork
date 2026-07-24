import { performance } from "node:perf_hooks";
import { Buffer } from "node:buffer";
import { appendFileSync, writeFileSync } from "node:fs";
import { KeycloakOIDCAuth } from "../util.js";
import { config } from "../config.js";

const WORKLOADS: Record<string, string[]> = {
  W1: [
    "smartphone-step",
    "wearable-gsr",
  ],
  W2: [
    "smartphone-step",
    "wearable-gsr",
    "wearable-bvp",
  ],
  W3: [
    "smartphone-step",
    "aqura-location-state",
    "wearable-gsr",
    "wearable-bvp",
  ],
  W4: [
    "smartphone-step",
    "aqura-location-state",
    "wearable-ibi",
    "wearable-gsr",
    "wearable-skt",
    "wearable-bvp",
  ],
  TEST: [
    "wearable-bvp",
    "wearable-ibi",
  ],
};

const SERVICE_METRICS: Record<string, string> = {
  "smartphone-step": "wear:smartphone.step",
  "aqura-location-state": "act:org.dyamand.aqura.AquraLocationState_Protego_User",
  "wearable-bvp": "wear:wearable.bvp",
  "wearable-gsr": "wear:wearable.gsr",
  "wearable-ibi": "wear:wearable.ibi",
  "wearable-skt": "wear:wearable.skt",
};

interface Options {
  user: string;
  password: string;
  aggregatorServer: string;
  aggregatorId: string;
  svcNames: string[];
  outputNames: string[];
  intervalMs: number;
  count: number;
  durationMs: number;
  runId: string;
  description: boolean;
  workload?: string;
  outFile?: string;
  readyFile?: string;
  resultMode: "poll" | "snapshot-and-stream";
  resultPageSize: number;
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

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function servicesForWorkload(workload: string): string[] {
  const key = workload.trim().toUpperCase();
  const services = WORKLOADS[key];
  if (!services) {
    throw new Error(`Unknown workload "${workload}". Expected one of: ${Object.keys(WORKLOADS).join(", ")}`);
  }
  return services;
}

function metricForService(service: string): string {
  return SERVICE_METRICS[service] ?? service;
}

interface SparqlBindingValue {
  value?: unknown;
}

type SparqlResultRow = Record<string, SparqlBindingValue | undefined>;

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

function sparqlBindings(parsed: unknown): SparqlResultRow[] | undefined {
  const bindings = (parsed as { results?: { bindings?: unknown } })?.results?.bindings;
  return Array.isArray(bindings) ? bindings as SparqlResultRow[] : undefined;
}

function resultRows(parsed: unknown): unknown[] | undefined {
  const bindings = sparqlBindings(parsed);
  if (bindings) return bindings;
  if (Array.isArray(parsed)) return parsed;

  const data = (parsed as { data?: Record<string, unknown> })?.data;
  if (!data || typeof data !== "object") return undefined;

  const firstArray = Object.values(data).find(Array.isArray);
  return firstArray as unknown[] | undefined;
}

function parseRowCount(body: string): number | null {
  try {
    const rows = resultRows(JSON.parse(body));
    return rows?.length ?? null;
  } catch {
    return null;
  }
}

function datasetValue(row: SparqlResultRow): string | undefined {
  const exactBinding = row.dataset ?? row.inDataset ?? row.void_inDataset;
  if (typeof exactBinding?.value === "string" && exactBinding.value) {
    return exactBinding.value;
  }

  for (const [key, binding] of Object.entries(row)) {
    if (key.toLowerCase().includes("dataset") && typeof binding?.value === "string" && binding.value) {
      return binding.value;
    }
  }

  return undefined;
}

function parseObservationCounts(body: string): { total: number | null; byPod: Map<string, number> } {
  const byPod = new Map<string, number>();

  try {
    const parsed = JSON.parse(body);
    const rows = resultRows(parsed);
    if (!rows) return { total: null, byPod };

    for (const row of rows) {
      if (!row || typeof row !== "object") continue;

      const pod = datasetValue(row as SparqlResultRow) ?? "unknown";
      byPod.set(pod, (byPod.get(pod) ?? 0) + 1);
    }

    return { total: rows.length, byPod };
  } catch {
    return { total: null, byPod };
  }
}

interface PaginationMetadata {
  snapshot?: string;
  snapshotSequence?: number;
  nextCursor?: string | null;
  totalRows?: number;
}

interface AdditionEvent {
  sequence: number;
  source?: string;
  count?: number;
  binding: SparqlResultRow;
}

function paginationMetadata(parsed: unknown): PaginationMetadata {
  return (
    parsed as {
      extensions?: { pagination?: PaginationMetadata };
    }
  )?.extensions?.pagination ?? {};
}

function addCounts(target: Map<string, number>, source: Map<string, number>): void {
  for (const [pod, count] of source) {
    target.set(pod, (target.get(pod) ?? 0) + count);
  }
}

function parseSseMessages(buffer: string): {
  events: Array<{ event: string; id?: string; data: string }>;
  rest: string;
} {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const messages = normalized.split("\n\n");
  const rest = messages.pop() ?? "";
  const events = messages.map((message) => {
    let event = "message";
    let id: string | undefined;
    const data: string[] = [];
    for (const line of message.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("id:")) id = line.slice(3).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    return { event, id, data: data.join("\n") };
  }).filter((event) => event.data !== "");
  return { events, rest };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readOptions(): Options {
  const user = getArg("--user") ?? process.env.POLL_USER;
  const aggregatorServer = withoutTrailingSlash(
    getArg("--aggregator-server")?.trim() ||
      process.env.POLL_AGGREGATOR_SERVER?.trim() ||
      config.aggregatorServer
  );
  const aggregatorId = getArg("--aggregator-id") ?? process.env.POLL_AGGREGATOR_ID;
  const password = getArg("--password") ?? process.env.POLL_PASSWORD ?? "pass";

  if (!user) {
    throw new Error("Missing required --user option, e.g. --user kronky4");
  }
  if (!aggregatorId) {
    throw new Error("Missing required --aggregator-id option, e.g. --aggregator-id 5146dde1-d4e0-46fa-9d0c-d05576165e9e");
  }

  const count = getArg("--count");
  const parsedCount = count ? Number(count) : Number.POSITIVE_INFINITY;
  if (count && (!Number.isFinite(parsedCount) || parsedCount < 1)) {
    throw new Error(`Invalid count: ${count}`);
  }

  const workload = getArg("--workload");
  const svcNames = workload
    ? servicesForWorkload(workload)
    : parseList(getArg("--svc"), config.svcName);
  const outputNames = parseList(getArg("--output"), "result");
  if (svcNames.length === 0) throw new Error("At least one service must be provided");
  if (outputNames.length > 1 && outputNames.length !== svcNames.length) {
    throw new Error("--output must contain either one value or the same number of comma-separated values as --svc");
  }
  const resultMode = getArg("--result-mode") ?? "snapshot-and-stream";
  if (resultMode !== "poll" && resultMode !== "snapshot-and-stream") {
    throw new Error("--result-mode must be either poll or snapshot-and-stream");
  }
  const resultPageSize = Number(getArg("--result-page-size") ?? "25000");
  if (!Number.isInteger(resultPageSize) || resultPageSize < 1 || resultPageSize > 500_000) {
    throw new Error("--result-page-size must be an integer between 1 and 500000");
  }

  return {
    user,
    password,
    aggregatorServer,
    aggregatorId,
    svcNames,
    outputNames,
    intervalMs: parseDurationMs(getArg("--interval"), 60_000),
    count: parsedCount,
    durationMs: parseDurationMs(getArg("--duration"), 0),
    runId: getArg("--run-id") ?? "manual",
    description: hasArg("--description"),
    workload: workload?.trim().toUpperCase(),
    outFile: getArg("--out"),
    readyFile: getArg("--ready-file"),
    resultMode,
    resultPageSize,
  };
}

function logMeasurement(opts: Options, event: Record<string, unknown>) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...event,
  });

  if (opts.outFile) {
    appendFileSync(opts.outFile, `${line}\n`, "utf8");
  }

  console.log(line);
}

function outputForService(opts: Options, index: number): string {
  return opts.outputNames[index] ?? opts.outputNames[0];
}

async function waitForInitialViewReady(
  umaFetch: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  opts: Options,
  svcName: string,
  endpoint: string,
  readyDeadline: number,
): Promise<void> {
  const statusUrl = new URL(endpoint);
  statusUrl.searchParams.set("mode", "status");
  const checkIntervalMs = Math.min(Math.max(opts.intervalMs, 5_000), 30_000);
  let announced = false;

  while (Date.now() < readyDeadline) {
    const response = await umaFetch(statusUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(
        `Initial-view readiness check failed: ${response.status} ${body.slice(0, 500)}`,
      );
    }

    const status = JSON.parse(body) as { ready?: unknown };
    if (status.ready === true) {
      console.error(`Initial view for ${svcName} is ready; fetching snapshot`);
      return;
    }
    if (status.ready !== false) {
      throw new Error("Initial-view readiness response did not contain a boolean ready field");
    }

    if (!announced) {
      console.error(
        `Waiting for ${svcName}'s initial view; checking lightweight status every ${checkIntervalMs}ms`,
      );
      announced = true;
    }
    await sleep(Math.min(checkIntervalMs, Math.max(0, readyDeadline - Date.now())));
  }

  throw new Error(`Timed out waiting for ${svcName}'s initial view`);
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
  let observationsByPod = new Map<string, number>();
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
    if (!response.ok) {
      error = body.slice(0, 500);
    }

    if (!opts.description) {
      const parseStarted = performance.now();
      const observationCounts = parseObservationCounts(body);
      rows = observationCounts.total ?? parseRowCount(body);
      observationsByPod = observationCounts.byPod;
      jsonParseMs = Math.round((performance.now() - parseStarted) * 1000) / 1000;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const commonEvent = {
    run_id: opts.runId,
    stage: opts.description ? "service_description_read" : "t7",
    event: "poll_result",
    aggregator: opts.aggregatorId,
    requestor: opts.user,
    workload: opts.workload,
    service: svcName,
    metric: metricForService(svcName),
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
  };

  if (observationsByPod.size > 0) {
    for (const [pod, observations] of observationsByPod) {
      logMeasurement(opts, {
        ...commonEvent,
        pod,
        patient: pod,
        observations,
      });
    }
  } else {
    logMeasurement(opts, {
      ...commonEvent,
      pod: opts.description ? endpoint : "all",
      patient: opts.description ? endpoint : "all",
      observations: rows ?? 0,
    });
  }
}

async function fetchInitialSnapshot(
  umaFetch: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  opts: Options,
  svcName: string,
  outputName: string,
  endpoint: string,
  readyDeadline: number = Date.now() + 10 * 60_000,
): Promise<{
  sequence: number;
  rows: number;
  byPod: Map<string, number>;
  snapshot?: string;
}> {
  const started = performance.now();
  const byPod = new Map<string, number>();
  const seenCursors = new Set<string>();
  let cursor: string | null | undefined;
  let sequence: number | undefined;
  let snapshot: string | undefined;
  let rows = 0;
  let pages = 0;
  let responseBytes = 0;
  let jsonParseMs = 0;

  await waitForInitialViewReady(
    umaFetch,
    opts,
    svcName,
    endpoint,
    readyDeadline,
  );

  do {
    const url = new URL(endpoint);
    url.searchParams.set("pageSize", String(opts.resultPageSize));
    if (cursor) url.searchParams.set("cursor", cursor);

    let response: Response;
    let body: string;
    response = await umaFetch(url, {
      method: "GET",
      headers: { Accept: "application/sparql-results+json, application/json" },
    });
    body = await response.text();
    responseBytes += Buffer.byteLength(body, "utf8");
    if (!response.ok) {
      throw new Error(`Snapshot page failed: ${response.status} ${body.slice(0, 500)}`);
    }

    const parseStarted = performance.now();
    const parsed = JSON.parse(body);
    const pageCounts = parseObservationCounts(body);
    jsonParseMs += performance.now() - parseStarted;
    if (pageCounts.total === null) {
      throw new Error("Snapshot page was not a SPARQL JSON result");
    }
    rows += pageCounts.total;
    addCounts(byPod, pageCounts.byPod);

    const pagination = paginationMetadata(parsed);
    if (sequence === undefined) sequence = Number(pagination.snapshotSequence);
    if (!Number.isInteger(sequence) || sequence! < 0) {
      throw new Error("Snapshot response did not contain a valid snapshotSequence");
    }
    if (snapshot === undefined) snapshot = pagination.snapshot;
    if (pagination.snapshot !== snapshot) {
      throw new Error("Snapshot ID changed while reading result pages");
    }

    cursor = pagination.nextCursor;
    pages++;
    if (pages > 100_000) throw new Error("Snapshot exceeded the page safety limit");
    if (cursor) {
      if (seenCursors.has(cursor)) throw new Error("Snapshot returned a repeated cursor");
      seenCursors.add(cursor);
    }
  } while (cursor);

  const common = {
    run_id: opts.runId,
    stage: "t7",
    event: "snapshot_result",
    aggregator: opts.aggregatorId,
    requestor: opts.user,
    workload: opts.workload,
    service: svcName,
    metric: metricForService(svcName),
    output: outputName,
    endpoint,
    status: 200,
    latency_ms: Math.round((performance.now() - started) * 1000) / 1000,
    response_bytes: responseBytes,
    rows,
    snapshot,
    snapshot_sequence: sequence,
    page_count: pages,
    page_size: opts.resultPageSize,
    json_parse_ms: Math.round(jsonParseMs * 1000) / 1000,
  };
  if (byPod.size > 0) {
    for (const [pod, observations] of byPod) {
      logMeasurement(opts, { ...common, pod, patient: pod, observations });
    }
  }
  // Keep an explicit aggregate as the final record for this timestamp. The
  // verifier uses it when one service combines several patient sources.
  logMeasurement(opts, { ...common, pod: "all", patient: "all", observations: rows });

  return { sequence: sequence!, rows, byPod, snapshot };
}

function logStreamSummary(
  opts: Options,
  details: {
    svcName: string;
    outputName: string;
    endpoint: string;
    snapshotRows: number;
    newRows: number;
    byPod: Map<string, number>;
    sequence: number;
    reconnects: number;
    event: "stream_summary" | "stream_finished";
  },
): void {
  const common = {
    run_id: opts.runId,
    stage: "t7",
    event: details.event,
    aggregator: opts.aggregatorId,
    requestor: opts.user,
    workload: opts.workload,
    service: details.svcName,
    metric: metricForService(details.svcName),
    output: details.outputName,
    endpoint: details.endpoint,
    status: 200,
    rows: details.snapshotRows + details.newRows,
    snapshot_rows: details.snapshotRows,
    new_rows: details.newRows,
    last_sequence: details.sequence,
    reconnects: details.reconnects,
  };
  if (details.byPod.size > 0) {
    for (const [pod, observations] of details.byPod) {
      logMeasurement(opts, { ...common, pod, patient: pod, observations });
    }
  }
  logMeasurement(opts, {
    ...common,
    pod: "all",
    patient: "all",
    observations: details.snapshotRows + details.newRows,
  });
}

async function runSnapshotAndStream(
  umaFetch: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  opts: Options,
  svcName: string,
  outputName: string,
  endpoint: string,
  stopAt: number,
  onSnapshotReady?: () => void,
): Promise<void> {
  const snapshot = await fetchInitialSnapshot(
    umaFetch,
    opts,
    svcName,
    outputName,
    endpoint,
    stopAt,
  );
  onSnapshotReady?.();
  const totalsByPod = new Map(snapshot.byPod);
  let sequence = snapshot.sequence;
  let newRows = 0;
  let reconnects = 0;
  let lastSummaryAt = Date.now();

  while (Date.now() < stopAt) {
    const url = new URL(endpoint);
    url.searchParams.set("mode", "changes");
    url.searchParams.set("after", String(sequence));
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), Math.max(1, stopAt - Date.now()));

    try {
      const response = await umaFetch(url, {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          "Last-Event-ID": String(sequence),
        },
        signal: abort.signal,
      });
      if (!response.ok || !response.body) {
        const body = await response.text();
        throw new Error(`Change stream failed: ${response.status} ${body.slice(0, 500)}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (Date.now() < stopAt) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsedMessages = parseSseMessages(buffer);
        buffer = parsedMessages.rest;

        for (const message of parsedMessages.events) {
          if (message.event === "add") {
            const addition = JSON.parse(message.data) as AdditionEvent;
            if (!Number.isInteger(addition.sequence) || addition.sequence <= sequence) {
              continue;
            }
            if (addition.sequence !== sequence + 1) {
              throw new Error(
                `Change stream sequence gap: expected ${sequence + 1}, received ${addition.sequence}`,
              );
            }
            sequence = addition.sequence;
            const count = Number.isInteger(addition.count) && (addition.count ?? 0) > 0
              ? addition.count!
              : 1;
            newRows += count;
            const pod = datasetValue(addition.binding) ?? "unknown";
            totalsByPod.set(pod, (totalsByPod.get(pod) ?? 0) + count);
          }
        }

        if (Date.now() - lastSummaryAt >= opts.intervalMs) {
          logStreamSummary(opts, {
            svcName,
            outputName,
            endpoint,
            snapshotRows: snapshot.rows,
            newRows,
            byPod: totalsByPod,
            sequence,
            reconnects,
            event: "stream_summary",
          });
          lastSummaryAt = Date.now();
        }
      }
    } catch (err) {
      if ((err as { name?: string })?.name !== "AbortError" || Date.now() < stopAt - 100) {
        throw err;
      }
    } finally {
      clearTimeout(timeout);
    }

    if (Date.now() < stopAt) {
      reconnects++;
      await sleep(Math.min(1000, Math.max(0, stopAt - Date.now())));
    }
  }

  logStreamSummary(opts, {
    svcName,
    outputName,
    endpoint,
    snapshotRows: snapshot.rows,
    newRows,
    byPod: totalsByPod,
    sequence,
    reconnects,
    event: "stream_finished",
  });
}

async function main() {
  const opts = readOptions();
  const stopAt = opts.durationMs > 0 ? Date.now() + opts.durationMs : Number.POSITIVE_INFINITY;
  if (opts.outFile) writeFileSync(opts.outFile, "", "utf8");

  console.error("=== Initializing Keycloak Authentication ===");
  console.error(`Poll requestor: ${opts.user}`);
  console.error(`Aggregator server: ${opts.aggregatorServer}`);
  console.error(`Aggregator id: ${opts.aggregatorId}`);
  const auth = new KeycloakOIDCAuth();
  await auth.init(config.idp, config.realm);
  await auth.login(
    opts.user,
    opts.password,
    config.clientId,
    config.clientSecret,
  );

  const umaFetch = auth.createUMAFetch();
  if (opts.workload) console.error(`Workload: ${opts.workload}`);
  console.error(`Polling services: ${opts.svcNames.join(", ")}`);
  if (!opts.description) console.error(`Polling outputs: ${opts.outputNames.join(", ")}`);
  console.error(`Interval: ${opts.intervalMs}ms`);
  console.error(`Result mode: ${opts.description ? "description-poll" : opts.resultMode}`);

  if (!opts.description && opts.resultMode === "snapshot-and-stream") {
    const stopAt = opts.durationMs > 0 ? Date.now() + opts.durationMs : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(stopAt)) {
      throw new Error("snapshot-and-stream mode requires a finite --duration");
    }
    let readyServices = 0;
    let readyFileWritten = false;
    const markSnapshotReady = () => {
      readyServices++;
      if (
        !readyFileWritten &&
        readyServices === opts.svcNames.length &&
        opts.readyFile
      ) {
        writeFileSync(
          opts.readyFile,
          `${JSON.stringify({
            run_id: opts.runId,
            services: opts.svcNames,
            ready_at: new Date().toISOString(),
          })}\n`,
          "utf8",
        );
        readyFileWritten = true;
        console.error(`All initial service snapshots ready: ${opts.readyFile}`);
      }
    };

    await Promise.all(opts.svcNames.map((svcName, index) => {
      const outputName = outputForService(opts, index);
      const endpoint = `${opts.aggregatorServer}/${opts.aggregatorId}/${svcName}/${outputName}`;
      return runSnapshotAndStream(
        umaFetch,
        opts,
        svcName,
        outputName,
        endpoint,
        stopAt,
        markSnapshotReady,
      );
    }));
    return;
  }

  let poll = 0;
  while (poll < opts.count && Date.now() <= stopAt) {
    poll++;
    const roundStartedAt = new Date().toISOString();

    await Promise.all(opts.svcNames.map((svcName, index) => {
      const outputName = outputForService(opts, index);
      const serviceEndpoint = `${opts.aggregatorServer}/${opts.aggregatorId}/${svcName}`;
      const outputEndpoint = `${serviceEndpoint}/${outputName}`;
      const endpoint = opts.description ? serviceEndpoint : outputEndpoint;

      if (!opts.description && opts.resultMode === "poll") {
        return fetchInitialSnapshot(umaFetch, opts, svcName, outputName, endpoint);
      }
      return pollEndpoint(umaFetch, opts, svcName, outputName, endpoint, poll, roundStartedAt);
    }));

    if (
      poll === 1 &&
      !opts.description &&
      opts.resultMode === "poll" &&
      opts.readyFile
    ) {
      writeFileSync(
        opts.readyFile,
        `${JSON.stringify({
          run_id: opts.runId,
          services: opts.svcNames,
          ready_at: new Date().toISOString(),
        })}\n`,
        "utf8",
      );
      console.error(`All initial service snapshots ready: ${opts.readyFile}`);
    }

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
