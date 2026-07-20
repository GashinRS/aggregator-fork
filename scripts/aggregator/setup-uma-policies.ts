import { config, umaId } from "../config.js";
import { KeycloakOIDCAuth } from "../util.js";
import { KvasirManagement } from "../kvasir/management.js";
import { createPolicies } from "../kvasir/policies.js";
import {
  DEFAULT_PATIENT_PASSWORD,
  kvasirPatientSources,
  kvasirServerForPatient,
} from "./kvasir-patients.js";

type UserKey = string;
type UserCredentials = {
  username: string;
  password: string;
};

const umaIdCache = new Map<UserKey, string>();
const KVASIR_CLIENT_SOURCES = kvasirPatientSources();
const numberedPatients = Array.from({ length: 30 }, (_, index) => `patient${index + 1}`);
const evalLowPatients = Array.from({ length: 30 }, (_, index) => `eval-low${index + 1}`);
const evalMediumPatients = Array.from({ length: 15 }, (_, index) => `eval-medium${index + 1}`);

// Map each aggregator owner to the patients whose slice data they need to query.
// Add another owner here if needed; the patient list itself is generated.
const AGGREGATOR_OWNER_PATIENTS: Record<UserKey, UserKey[]> = {
  //patient1: ['patient1,patient3,patient4,patient5,patient6,patient7,patient8,patient9,patient10,patient11,patient12,patient13,patient14,patient15,patient16,patient17,patient18,patient19,patient20,patient21,patient22,patient23,patient24,patient25,patient26,patient27,patient28,patient29,patient30,patient31'],
  //patient15: numberedPatients,
  //"eval-low1": evalLowPatients,
  //"eval-low1": ['eval-low8,eval-low9,eval-low10,eval-low11'],
  //"eval-low12": ['eval-low12,eval-low13']
  // "eval-medium1": evalMediumPatients,
  //"teststream": ['teststream,teststream5'],
  // "rorii6": ['rorii6,rorii7'],
  // "patient1": ['patient1']
  // "kronky4": ['kronky4,kronky5,kronky6']
  // "eval-low2": ['eval-low2']
  "newtest17": ['newtest17']
  // "eval-medium13": ['eval-medium13'],
};

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function umaServerForPolicyRegistration(): string {
  if (process.env.UMA_POLICY_SERVER) {
    return withoutTrailingSlash(process.env.UMA_POLICY_SERVER);
  }

  const base = withoutTrailingSlash(config.asServer);
  return base.endsWith("/uma/uma") ? base : `${base}/uma`;
}

function configuredCredentials(user: UserKey): UserCredentials | undefined {
  const maybeConfig = (config as unknown as Record<string, Partial<UserCredentials>>)[user];
  if (typeof maybeConfig?.username !== "string") {
    return undefined;
  }

  return {
    username: maybeConfig.username,
    password:
      typeof maybeConfig.password === "string"
        ? maybeConfig.password
        : DEFAULT_PATIENT_PASSWORD,
  };
}

function credentialsFor(user: UserKey): UserCredentials {
  const configured = configuredCredentials(user);

  if (usesDefaultPatientPassword(user) || (!configured && isPolicyUser(user))) {
    return {
      username: configured?.username ?? user,
      password: DEFAULT_PATIENT_PASSWORD,
    };
  }

  if (configured) {
    return configured;
  }

  throw new Error(`No credentials configured for ${user}`);
}

function kvasirServerFor(patient: UserKey): string {
  return (
    KVASIR_CLIENT_SOURCES.find(({ client }) => client === patient)?.server ??
    kvasirServerForPatient(patient, config.kvasirServer)
  );
}

function podUrl(patient: UserKey): string {
  return `${withoutTrailingSlash(kvasirServerFor(patient))}/${credentialsFor(patient).username}`;
}

function sliceUrl(patient: UserKey): string {
  return `${podUrl(patient)}/slices/${config.sliceName}`;
}

function policyName(owner: UserKey, patient: UserKey, endpoint: "Query" | "Changes"): string {
  const suffix = owner === patient ? "Owner" : "AggregatorOwner";
  return `${config.sliceName}_${patient}_${suffix}${endpoint}`.replace(/[^A-Za-z0-9_]/g, "_");
}

function usesDefaultPatientPassword(user: UserKey): boolean {
  return /^(patient|eval-low|eval-medium)\d+$/.test(user);
}

function isPolicyUser(user: UserKey): boolean {
  return Object.entries(AGGREGATOR_OWNER_PATIENTS).some(
    ([owner, patients]) =>
      owner === user || normalizedPatients(patients).includes(user)
  );
}

function normalizedPatients(patients: UserKey[]): UserKey[] {
  return patients.flatMap((patient) =>
    patient
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
  );
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const [, payload] = token.split(".");
  if (!payload) {
    throw new Error("Token did not contain a JWT payload");
  }

  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

async function actualUmaId(user: UserKey): Promise<string> {
  const cached = umaIdCache.get(user);
  if (cached) {
    return cached;
  }

  const credentials = credentialsFor(user);
  const auth = new KeycloakOIDCAuth();
  await auth.init(config.idp, config.realm);
  await auth.login(
    credentials.username,
    credentials.password,
    config.clientId,
    config.clientSecret
  );

  const payload = decodeJwtPayload(await auth.getIdToken());
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error(`ID token for ${user} did not contain a sub claim`);
  }

  const id = umaId(payload.sub);
  umaIdCache.set(user, id);
  console.log(`Resolved ${user} UMA id: ${id}`);
  return id;
}

async function setupPoliciesForPatient(owner: UserKey, patient: UserKey) {
  const ownerUmaId = await actualUmaId(owner);
  const patientUmaId = await actualUmaId(patient);
  const patientCredentials = credentialsFor(patient);
  const patientPodUrl = podUrl(patient);
  const patientSliceUrl = sliceUrl(patient);
  const scopes = owner === patient ? ["read", "write"] : ["read"];

  console.log(`=== Setting up ${patient}'s UMA policies for owner ${owner} ===`);
  console.log(`Pod:   ${patientPodUrl}`);
  console.log(`Slice: ${patientSliceUrl}`);

  const kvasir = new KvasirManagement(patientPodUrl, umaServerForPolicyRegistration());
  await kvasir.init(config.idp, config.realm);
  await kvasir.login(
    patientCredentials.username,
    patientCredentials.password,
    config.clientId,
    config.clientSecret
  );

  console.log("-> Delegating pod access control to UMA");
  await kvasir.delegatePodToUMA();

  console.log(`-> Granting ${owner} ${scopes.join(",")} access to ${patient}'s slice query endpoints`);
  const { turtle } = await createPolicies([
    {
      name: policyName(owner, patient, "Query"),
      assignee: ownerUmaId,
      assigner: patientUmaId,
      target: `${patientSliceUrl}/query`,
      scopes,
    },
    {
      name: policyName(owner, patient, "Changes"),
      assignee: ownerUmaId,
      assigner: patientUmaId,
      target: `${patientSliceUrl}/changes`,
      scopes,
    },
  ]);

  await kvasir.registerPolicies(turtle);
}

async function main() {
  for (const [owner, rawPatients] of Object.entries(AGGREGATOR_OWNER_PATIENTS)) {
    const patients = normalizedPatients(rawPatients);
    if (patients.length === 0) {
      continue;
    }

    console.log(`\n### Aggregator owner ${owner}: ${patients.join(", ")} ###`);
    for (const patient of patients) {
      await setupPoliciesForPatient(owner, patient);
    }
  }

  console.log("\n=== UMA policy setup complete ===");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
