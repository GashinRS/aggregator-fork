import { config, umaId } from "../config.js";
import { KeycloakOIDCAuth } from "../util.js";
import { KvasirManagement } from "../kvasir/management.js";
import { createPolicies } from "../kvasir/policies.js";

type ConfigUserKey = "alice" | "bob" | "patient1" | "patient3" | "patient30" | "patient5" | "patient6";

type OwnerPatientMap = Record<ConfigUserKey, ConfigUserKey[]>;
type KvasirClientSource = {
  client: ConfigUserKey;
  server: string;
};

const DEFAULT_PATIENT_PASSWORD = "pass";
const umaIdCache = new Map<ConfigUserKey, string>();

// Map each aggregator owner to the patients whose slice data they need to query.
// Add more entries here as new owners/patients are needed.
const AGGREGATOR_OWNER_PATIENTS: OwnerPatientMap = {
  patient1: ["patient1", "patient30"],
  alice: [],
  bob: [],
  patient3: [],
  patient5: ["patient5"],
  patient6: ["patient6"],
  patient30: [],
};

const KVASIR_CLIENT_SOURCES: KvasirClientSource[] = [
  {
    client: "patient1",
    server: "https://10.10.220.125",
  },
  {
    client: "patient3",
    server: "https://10.10.223.39",
  },
  {
    client: "patient5",
    server: "https://10.10.216.12",
  },
  {
    client: "patient30",
    server: "https://10.10.221.120",
  },
  {
    client: "patient6",
    server: "https://10.10.218.59",
  },
];

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

function kvasirServerFor(patient: ConfigUserKey): string {
  return KVASIR_CLIENT_SOURCES.find(({ client }) => client === patient)?.server ?? config.kvasirServer;
}

function podUrl(patient: ConfigUserKey): string {
  return `${withoutTrailingSlash(kvasirServerFor(patient))}/${config[patient].username}`;
}

function sliceUrl(patient: ConfigUserKey): string {
  return `${podUrl(patient)}/slices/${config.sliceName}`;
}

function policyName(owner: ConfigUserKey, patient: ConfigUserKey, endpoint: "Query" | "Changes"): string {
  const suffix = owner === patient ? "Owner" : "AggregatorOwner";
  return `${config.sliceName}_${patient}_${suffix}${endpoint}`.replace(/[^A-Za-z0-9_]/g, "_");
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const [, payload] = token.split(".");
  if (!payload) {
    throw new Error("Token did not contain a JWT payload");
  }

  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

async function actualUmaId(user: ConfigUserKey): Promise<string> {
  const cached = umaIdCache.get(user);
  if (cached) {
    return cached;
  }

  const auth = new KeycloakOIDCAuth();
  await auth.init(config.idp, config.realm);
  await auth.login(
    config[user].username,
    DEFAULT_PATIENT_PASSWORD,
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

async function setupPoliciesForPatient(owner: ConfigUserKey, patient: ConfigUserKey) {
  const ownerUmaId = await actualUmaId(owner);
  const patientUmaId = await actualUmaId(patient);
  const patientPodUrl = podUrl(patient);
  const patientSliceUrl = sliceUrl(patient);
  const scopes = owner === patient ? ["read", "write"] : ["read"];

  console.log(`=== Setting up ${patient}'s UMA policies for owner ${owner} ===`);
  console.log(`Pod:   ${patientPodUrl}`);
  console.log(`Slice: ${patientSliceUrl}`);

  const kvasir = new KvasirManagement(patientPodUrl, umaServerForPolicyRegistration());
  await kvasir.init(config.idp, config.realm);
  await kvasir.login(
    config[patient].username,
    DEFAULT_PATIENT_PASSWORD,
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
  for (const [owner, patients] of Object.entries(AGGREGATOR_OWNER_PATIENTS) as [ConfigUserKey, ConfigUserKey[]][]) {
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
