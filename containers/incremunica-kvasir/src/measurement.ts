export interface MeasurementEvent {
  stage: string;
  event: string;
  service: string;
  run_id: string;
  pod: string;
  observations: number;
  ts?: string;
  [key: string]: unknown;
}

const RUN_ID = process.env.RUN_ID || process.env.EVALUATION_RUN_ID || "manual";
const SERVICE_NAME = process.env.SERVICE_NAME || process.env.HOSTNAME || "incremunica-kvasir";

export function measurementBase() {
  return {
    run_id: RUN_ID,
    service: SERVICE_NAME,
  };
}

export function logMeasurement(event: Omit<MeasurementEvent, "ts" | "run_id" | "service">) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    ...measurementBase(),
    ...event,
  }));
}

export function viewRowCount(view: Map<string, { count: number }>): number {
  let rows = 0;
  for (const entry of view.values()) rows += entry.count;
  return rows;
}

export function newestObservationTimestamp(view: Map<string, { bindings: Iterable<[unknown, unknown]> }>): string | undefined {
  let newestMs = Number.NEGATIVE_INFINITY;

  for (const entry of view.values()) {
    for (const [variable, term] of entry.bindings) {
      const variableName = variableLocalName(variable);
      if (variableName !== "timestamp" && variableName !== "saref_hasTimestamp" && variableName !== "hasTimestamp") {
        continue;
      }

      const value = bindingTermValue(term);
      if (!value) continue;

      const time = Date.parse(value);
      if (Number.isNaN(time) || time <= newestMs) continue;
      newestMs = time;
    }
  }

  return Number.isFinite(newestMs) ? new Date(newestMs).toISOString() : undefined;
}

function variableLocalName(variable: unknown): string | undefined {
  const value = objectValue(variable);
  if (typeof value !== "string") return undefined;

  const withoutPrefix = value.replace(/^[?$]+/, "");
  const hashIndex = withoutPrefix.lastIndexOf("#");
  const slashIndex = withoutPrefix.lastIndexOf("/");
  const localIndex = Math.max(hashIndex, slashIndex);
  return localIndex >= 0 ? withoutPrefix.slice(localIndex + 1) : withoutPrefix;
}

function bindingTermValue(term: unknown): string | undefined {
  const value = objectValue(term);
  return typeof value === "string" ? value : undefined;
}

function objectValue(value: unknown): unknown {
  return typeof value === "object" && value !== null && "value" in value
    ? (value as { value?: unknown }).value
    : undefined;
}
