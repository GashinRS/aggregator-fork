import { config } from "../config.js";
import { KvasirManagement } from "../kvasir/management.js";
import {
  DEFAULT_PATIENT_PASSWORD,
  kvasirPatientSources,
} from "./kvasir-patients.js";

type UserCredentials = {
  username: string;
  password: string;
};

const SLICE_NAME = "data";
const SLICE_DESCRIPTION = "PACSOI patient observation data";

const CONTEXT = {
  saref: "https://saref.etsi.org/core/",
  void: "http://rdfs.org/ns/void#",
  protego: "https://dahcc.idlab.ugent.be/Protego/",
  wear: "https://dahcc.idlab.ugent.be/Homelab/SensorsAndWearables/",
  act: "https://dahcc.idlab.ugent.be/Homelab/SensorsAndActuators/",
  saw: "https://dahcc.idlab.ugent.be/Ontology/SensorsAndWearables/",
  saa: "https://dahcc.idlab.ugent.be/Ontology/SensorsAndActuators/",
  xsd: "http://www.w3.org/2001/XMLSchema#",
  kss: "https://kvasir.discover.ilabt.imec.be/vocab#",
};

const SCHEMA = `type Query {
  saref_Observation: [saref_Observation]!
}

type saref_Observation @class(iri: "saref:Observation") {
  id: ID!
  saref_hasTimestamp: DateTime @predicate(iri: "saref:hasTimestamp")
  saref_hasValue: String @predicate(iri: "saref:hasValue")
  saref_madeBy: [ID] @predicate(iri: "saref:madeBy")
  saref_observes: [ID] @predicate(iri: "saref:observes")
  void_inDataset: [ID] @predicate(iri: "void:inDataset")
}

type Subscription {
  saref_ObservationAdded: saref_Observation!
}

type Mutation {
  addSarefObservation(obs: SarefObservationInput!): ID!
}

input SarefObservationInput @class(iri: "saref:Observation") {
  id: ID!
  saref_hasTimestamp: DateTime @predicate(iri: "saref:hasTimestamp")
  saref_hasValue: String @predicate(iri: "saref:hasValue")
  saref_madeBy: [ID] @predicate(iri: "saref:madeBy")
  saref_observes: [ID] @predicate(iri: "saref:observes")
  void_inDataset: [ID] @predicate(iri: "void:inDataset")
}`;

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

function configuredCredentials(user: string): UserCredentials | undefined {
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

function credentialsFor(user: string): UserCredentials {
  return {
    username: configuredCredentials(user)?.username ?? user,
    password: configuredCredentials(user)?.password ?? DEFAULT_PATIENT_PASSWORD,
  };
}

async function createSliceForPatient(client: string, server: string): Promise<string> {
  const credentials = credentialsFor(client);
  const podUrl = `${withoutTrailingSlash(server)}/${credentials.username}`;
  const kvasir = new KvasirManagement(podUrl, umaServerForPolicyRegistration());

  await kvasir.init(config.idp, config.realm);
  await kvasir.login(
    credentials.username,
    credentials.password,
    config.clientId,
    config.clientSecret
  );

  return kvasir.registerSlice(CONTEXT, SCHEMA, SLICE_NAME, SLICE_DESCRIPTION);
}

async function main() {
  const sources = kvasirPatientSources();
  const failures: Array<{ patient: string; error: unknown }> = [];

  console.log(`=== Creating "${SLICE_NAME}" slice for ${sources.length} Kvasir patients ===`);

  for (const { client, server } of sources) {
    console.log(`\n=== ${client} (${server}) ===`);

    try {
      const slice = await createSliceForPatient(client, server);
      console.log(`Slice ready: ${slice}`);
    } catch (error) {
      failures.push({ patient: client, error });
      console.error(`Failed to create slice for ${client}:`, error);
    }
  }

  const createdOrExisting = sources.length - failures.length;
  console.log(
    `\n=== Finished: ${createdOrExisting}/${sources.length} slices ready, ${failures.length} failed ===`
  );

  if (failures.length > 0) {
    console.log(`Failed patients: ${failures.map(({ patient }) => patient).join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
