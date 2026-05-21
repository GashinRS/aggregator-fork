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
