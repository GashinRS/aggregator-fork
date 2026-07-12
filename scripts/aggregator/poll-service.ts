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

  let poll = 0;
  while (poll < opts.count && Date.now() <= stopAt) {
    poll++;
    const roundStartedAt = new Date().toISOString();

    await Promise.all(opts.svcNames.map((svcName, index) => {
      const outputName = outputForService(opts, index);
      const serviceEndpoint = `${opts.aggregatorServer}/${opts.aggregatorId}/${svcName}`;
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
