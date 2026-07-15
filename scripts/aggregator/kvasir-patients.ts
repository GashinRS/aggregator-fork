export type KvasirPatientSource = {
  client: string;
  server: string;
};

export const DEFAULT_PATIENT_PASSWORD = "pass";
export const DEFAULT_KVASIR_PATIENT_COUNT = 31;
const EVAL_LOW_PATIENT_COUNT = 31;
const EVAL_MEDIUM_PATIENT_COUNT = 31;

// Add a prefix here to create `<prefix>1` through `<prefix>31`, with each
// client assigned to the Kvasir server whose number matches its suffix.
const ALL_SERVER_PATIENT_PREFIXES = ["newtest"];

const EXTRA_KVASIR_PATIENT_SOURCES: KvasirPatientSource[] = [
  {
    client: "teststream",
    server: "https://10.10.220.125",
  },
];

const KVASIR_SERVER_IPS: Record<number, string> = {
  1: "10.10.220.125",
  2: "10.10.220.123",
  3: "10.10.223.39",
  4: "10.10.223.11",
  5: "10.10.216.12",
  6: "10.10.218.59",
  7: "10.10.218.183",
  8: "10.10.221.243",
  9: "10.10.222.26",
  10: "10.10.222.77",
  11: "10.10.223.118",
  12: "10.10.220.235",
  13: "10.10.223.150",
  14: "10.10.210.84",
  15: "10.10.210.206",
  16: "10.10.215.81",
  17: "10.10.213.90",
  18: "10.10.215.31",
  19: "10.10.218.138",
  20: "10.10.221.26",
  21: "10.10.216.86",
  22: "10.10.217.196",
  23: "10.10.223.254",
  24: "10.10.220.180",
  25: "10.10.219.65",
  26: "10.10.221.179",
  27: "10.10.219.111",
  28: "10.10.217.149",
  29: "10.10.221.6",
  30: "10.10.221.120",
  31: "10.10.217.141",
};

function parsePatientNumber(patient: string): number | undefined {
  const match = /^patient(\d+)$/.exec(patient);
  return match ? Number(match[1]) : undefined;
}

function patientCount(): number {
  const raw = process.env.KVASIR_PATIENT_COUNT;
  if (!raw) {
    return DEFAULT_KVASIR_PATIENT_COUNT;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`KVASIR_PATIENT_COUNT must be a positive integer, got "${raw}"`);
  }

  return parsed;
}

export function patientName(index: number): string {
  return `patient${index}`;
}

function sourceFor(client: string, kvasirIndex: number): KvasirPatientSource {
  const ip = KVASIR_SERVER_IPS[kvasirIndex];

  if (!ip) {
    throw new Error(
      `No Kvasir server IP configured for kvasir${kvasirIndex}. Add it to KVASIR_SERVER_IPS.`
    );
  }

  return {
    client,
    server: `https://${ip}`,
  };
}

function evalSourceFor(client: string, index: number): KvasirPatientSource {
  const serverCount = Object.keys(KVASIR_SERVER_IPS).length;
  const kvasirIndex = ((index - 1) % serverCount) + 1;
  return sourceFor(client, kvasirIndex);
}

function numberedPatientSources(count: number): KvasirPatientSource[] {
  return Array.from({ length: count }, (_, index) => {
    const patientNumber = index + 1;
    return sourceFor(patientName(patientNumber), patientNumber);
  });
}

function allServerPatientSources(): KvasirPatientSource[] {
  const serverNumbers = Object.keys(KVASIR_SERVER_IPS).map(Number);

  return ALL_SERVER_PATIENT_PREFIXES.flatMap((prefix) =>
    serverNumbers.map((serverNumber) => sourceFor(`${prefix}${serverNumber}`, serverNumber))
  );
}

function evalPatientSources(): KvasirPatientSource[] {
  const low = Array.from({ length: EVAL_LOW_PATIENT_COUNT }, (_, index) =>
    evalSourceFor(`eval-low${index + 1}`, index + 1)
  );
  const medium = Array.from({ length: EVAL_MEDIUM_PATIENT_COUNT }, (_, index) =>
    evalSourceFor(`eval-medium${index + 1}`, index + 1)
  );

  return [...low, ...medium];
}

export function kvasirPatientSources(count = patientCount()): KvasirPatientSource[] {
  return [
    ...numberedPatientSources(count),
    ...allServerPatientSources(),
    ...evalPatientSources(),
    ...EXTRA_KVASIR_PATIENT_SOURCES,
  ];
}

export function kvasirServerForPatient(patient: string, fallbackServer: string): string {
  const patientNumber = parsePatientNumber(patient);
  if (!patientNumber) {
    return fallbackServer;
  }

  const ip = KVASIR_SERVER_IPS[patientNumber];
  return ip ? `https://${ip}` : fallbackServer;
}
