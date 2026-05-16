import { KeycloakOIDCAuth } from "../util.js";
import { DataFactory } from "rdf-data-factory";
import { Writer } from "n3";
import { config } from "../config.js";
import {
  DEFAULT_KVASIR_PATIENT_COUNT,
  DEFAULT_PATIENT_PASSWORD,
  kvasirPatientSources,
  type KvasirPatientSource,
} from "./kvasir-patients.js";

const df = new DataFactory();

const AGGREGATOR_SERVER = config.aggregatorServer;
const AGGREGATOR = `${config.aggregatorServer}/${config.aggregatorId}`;
const TF = "/transformations";
const SVC = "/services";
const TF_ID = "IncrementalKvasir";
const CREATED_STATUS_CODES = new Set([201, 202]);
const SERVICE_REQUESTOR = "patient15";
const SERVICE_REQUESTOR_PASSWORD = DEFAULT_PATIENT_PASSWORD;
// const SERVICE_CREATION_WAIT_MS = 60_000;
const SERVICE_CREATION_WAIT_MS = 0;

type ServiceDefinition = {
  service: string;
  metric: string;
};

type UserCredentials = {
  username: string;
  password: string;
};

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function requestorCredentials(): UserCredentials {
  const maybeConfig = (config as unknown as Record<string, Partial<UserCredentials>>)[
    SERVICE_REQUESTOR
  ];

  return {
    username: maybeConfig?.username ?? SERVICE_REQUESTOR,
    password:
      typeof maybeConfig?.password === "string"
        ? maybeConfig.password
        : SERVICE_REQUESTOR_PASSWORD,
  };
}

function requestedPatients(): string[] | undefined {
  return process.env.KVASIR_PATIENTS
    ?.split(",")
    .map((patient) => patient.trim())
    .filter(Boolean);
}

function selectedKvasirPatientSources(): {
  sources: KvasirPatientSource[];
  requested: string[] | undefined;
} {
  const requested = requestedPatients();
  const requestedPatientSet = requested ? new Set(requested) : undefined;
  const allSources = requestedPatientSet
    ? kvasirPatientSources(DEFAULT_KVASIR_PATIENT_COUNT)
    : kvasirPatientSources();
  const sources = allSources.filter(({ client }) =>
    requestedPatientSet ? requestedPatientSet.has(client) : true
  );

  if (requestedPatientSet && sources.length !== requestedPatientSet.size) {
    const found = new Set(sources.map(({ client }) => client));
    const missing = [...requestedPatientSet].filter((patient) => !found.has(patient));
    throw new Error(`Unknown Kvasir patients requested: ${missing.join(", ")}`);
  }

  return { sources, requested };
}

function sourceList(sources: KvasirPatientSource[]): string {
  return sources
    .map(({ client, server }) => `${withoutTrailingSlash(server)}/${client}/slices/${config.sliceName}/query`)
    .join(",");
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function timestamp(): string {
  return new Date().toISOString();
}

function formatDuration(ms: number): string {
  return `${Math.round(ms / 100) / 10}s`;
}

// Edit this list to choose which services this script creates.
// Metrics should already include the correct query token:
// - wear:* for Homelab/SensorsAndWearables metrics
// - act:* for Homelab/SensorsAndActuators metrics
// - <full IRI> for metric names that are not legal SPARQL prefixed names
const RAW_SERVICES: ServiceDefinition[] = [
  // { service: "smartphone-acceleration-x", metric: "wear:smartphone.acceleration.x" },
  // { service: "smartphone-acceleration-y", metric: "wear:smartphone.acceleration.y" },
  // { service: "smartphone-acceleration-z", metric: "wear:smartphone.acceleration.z" },
  // { service: "smartphone-magnetometer-x", metric: "wear:smartphone.magnetometer.x" },
  // { service: "smartphone-magnetometer-y", metric: "wear:smartphone.magnetometer.y" },
  // { service: "smartphone-magnetometer-z", metric: "wear:smartphone.magnetometer.z" },
  // { service: "smartphone-gravity-x", metric: "wear:smartphone.gravity.x" },
  // { service: "smartphone-gravity-y", metric: "wear:smartphone.gravity.y" },
  // { service: "smartphone-gravity-z", metric: "wear:smartphone.gravity.z" },
  // { service: "smartphone-gyroscope-x", metric: "wear:smartphone.gyroscope.x" },
  // { service: "smartphone-gyroscope-y", metric: "wear:smartphone.gyroscope.y" },
  // { service: "smartphone-gyroscope-z", metric: "wear:smartphone.gyroscope.z" },
  // { service: "smartphone-linear-acceleration-x", metric: "wear:smartphone.linear_acceleration.x" },
  // { service: "smartphone-linear-acceleration-y", metric: "wear:smartphone.linear_acceleration.y" },
  // { service: "smartphone-linear-acceleration-z", metric: "wear:smartphone.linear_acceleration.z" },
  // { service: "smartphone-rotation-x", metric: "wear:smartphone.rotation.x" },
  // { service: "smartphone-rotation-y", metric: "wear:smartphone.rotation.y" },
  // { service: "smartphone-rotation-z", metric: "wear:smartphone.rotation.z" },
  // { service: "wearable-acceleration-x", metric: "wear:wearable.acceleration.x" },
  // { service: "wearable-acceleration-y", metric: "wear:wearable.acceleration.y" },
  // { service: "wearable-acceleration-z", metric: "wear:wearable.acceleration.z" },
  // { service: "energy-consumption", metric: "act:energy.consumption" },
  // { service: "energy-power", metric: "act:energy.power" },
  // { service: "environment-light", metric: "act:environment.light" },
  // { service: "environment-temperature", metric: "act:environment.temperature" },
  // { service: "people-presence-detected", metric: "act:people.presence.detected" },
  // { service: "mqtt-last-message", metric: "act:mqtt.lastMessage" },
  // { service: "people-presence-number-detected", metric: "act:people.presence.numberDetected" },
  // { service: "environment-motion", metric: "act:environment.motion" },
  // { service: "smartphone-ambient-light", metric: "wear:smartphone.ambient_light" },
  // { service: "environment-voltage", metric: "act:environment.voltage" },
  // { service: "environment-relativehumidity", metric: "act:environment.relativehumidity" },
  // { service: "airquality-co2", metric: "act:airquality.co2" },
  // { service: "smartphone-application", metric: "wear:smartphone.application" },
  // { service: "smartphone-keyboard", metric: "wear:smartphone.keyboard" },
  // { service: "weather-pressure", metric: "act:weather.pressure" },
  { service: "smartphone-step", metric: "wear:smartphone.step" },
  // { service: "environment-open", metric: "act:environment.open" },
  // { service: "airquality-voc-total", metric: "act:airquality.voc_total" },
  // { service: "smartphone-proximity", metric: "wear:smartphone.proximity" },
  // { service: "aqura-location-state", metric: "act:org.dyamand.aqura.AquraLocationState_Protego_User" },
  // { service: "dyamand-airquality-co2", metric: "act:org.dyamand.types.airquality.CO2" },
  // { service: "atmospheric-pressure", metric: "act:org.dyamand.types.common.AtmosphericPressure" },
  // { service: "loudness", metric: "act:org.dyamand.types.common.Loudness" },
  // { service: "relative-humidity", metric: "act:org.dyamand.types.common.RelativeHumidity" },
  // { service: "temperature", metric: "act:org.dyamand.types.common.Temperature" },
  // { service: "water-running", metric: "<https://dahcc.idlab.ugent.be/Homelab/SensorsAndActuators/environment.waterRunning::bool>" },
  // { service: "environment-lightswitch", metric: "act:environment.lightswitch" },
  // { service: "weather-rainrate", metric: "act:weather.rainrate" },
  // { service: "weather-windspeed", metric: "act:weather.windspeed" },
  // { service: "environment-relay", metric: "act:environment.relay" },
  // { service: "environment-button", metric: "act:environment.button" },
  { service: "wearable-battery-level", metric: "wear:wearable.battery_level" },
  // { service: "smartphone-screen", metric: "wear:smartphone.screen" },
  // { service: "environment-blind", metric: "act:environment.blind" },
  // { service: "wearable-on-wrist", metric: "wear:wearable.on_wrist" },
  // { service: "smartphone-location-accuracy", metric: "wear:smartphone.location.accuracy" },
  // { service: "smartphone-location-altitude", metric: "wear:smartphone.location.altitude" },
  // { service: "smartphone-location-bearing", metric: "wear:smartphone.location.bearing" },
  // { service: "smartphone-location-latitude", metric: "wear:smartphone.location.latitude" },
  // { service: "smartphone-location-longitude", metric: "wear:smartphone.location.longitude" },
  // { service: "environment-dimmer", metric: "act:environment.dimmer" },
  // { service: "heart-rate", metric: "wear:org.dyamand.types.health.HeartRate" },
  // { service: "spo2", metric: "wear:org.dyamand.types.health.SpO2" },
  // { service: "load", metric: "act:org.dyamand.types.common.Load" },
  { service: "body-temperature", metric: "wear:org.dyamand.types.health.BodyTemperature" },
  { service: "diastolic-blood-pressure", metric: "wear:org.dyamand.types.health.DiastolicBloodPressure" },
  { service: "systolic-blood-pressure", metric: "wear:org.dyamand.types.health.SystolicBloodPressure" },
  // { service: "wearable-bvp", metric: "wear:wearable.bvp" },
  // { service: "wearable-gsr", metric: "wear:wearable.gsr" },
  // { service: "wearable-skt", metric: "wear:wearable.skt" },
  // { service: "wearable-ibi", metric: "wear:wearable.ibi" },
];

const SAMPLED_SERVICES: ServiceDefinition[] = [
  { service: "wearable-bvp", metric: "wear:wearable.bvp" },
  { service: "wearable-gsr", metric: "wear:wearable.gsr" },
  { service: "wearable-skt", metric: "wear:wearable.skt" },
  { service: "wearable-ibi", metric: "wear:wearable.ibi" },
];

const SCHEMA = `
type Query {
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
}
`;

const CONTEXT = JSON.stringify({
  saref: "https://saref.etsi.org/core/",
  void: "http://rdfs.org/ns/void#",
  protego: "https://dahcc.idlab.ugent.be/Protego/",
  wear: "https://dahcc.idlab.ugent.be/Homelab/SensorsAndWearables/",
  act: "https://dahcc.idlab.ugent.be/Homelab/SensorsAndActuators/",
  saw: "https://dahcc.idlab.ugent.be/Ontology/SensorsAndWearables/",
  saa: "https://dahcc.idlab.ugent.be/Ontology/SensorsAndActuators/",
  xsd: "http://www.w3.org/2001/XMLSchema#",
  kss: "https://kvasir.discover.ilabt.imec.be/vocab#",
});

function toSparqlMetric(metric: string): string {
  if (metric.startsWith("<") || metric.includes(":")) {
    return metric;
  }

  throw new Error(
    `Metric "${metric}" is missing a prefix. Use wear:*, act:*, or <full IRI>.`
  );
}

function metricQuery(metric: string): string {
  return `
PREFIX saref: <https://saref.etsi.org/core/>
PREFIX void: <http://rdfs.org/ns/void#>
PREFIX wear: <https://dahcc.idlab.ugent.be/Homelab/SensorsAndWearables/>
PREFIX act: <https://dahcc.idlab.ugent.be/Homelab/SensorsAndActuators/>

SELECT ?dataset ?timestamp ?value
WHERE {
  ?obs saref:observes ${toSparqlMetric(metric)} ;
       saref:hasTimestamp ?timestamp ;
       saref:hasValue ?value ;
       void:inDataset ?dataset .
}
`;
}

function sampledMetricQuery(metric: string): string {
  return `
PREFIX saref: <https://saref.etsi.org/core/>
PREFIX void: <http://rdfs.org/ns/void#>
PREFIX wear: <https://dahcc.idlab.ugent.be/Homelab/SensorsAndWearables/>
PREFIX act: <https://dahcc.idlab.ugent.be/Homelab/SensorsAndActuators/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>

SELECT ?dataset ?year ?month ?day ?hour ?minuteBucket (SAMPLE(?timestamp) AS ?timestamp) (SAMPLE(?value) AS ?value)
WHERE {
  ?obs saref:observes ${toSparqlMetric(metric)} ;
       saref:hasTimestamp ?timestamp ;
       saref:hasValue ?value ;
       void:inDataset ?dataset .

  BIND(YEAR(?timestamp) AS ?year)
  BIND(MONTH(?timestamp) AS ?month)
  BIND(DAY(?timestamp) AS ?day)
  BIND(HOURS(?timestamp) AS ?hour)
  BIND((FLOOR(MINUTES(?timestamp) / 5) * 5) AS ?minuteBucket)
}
GROUP BY ?dataset ?year ?month ?day ?hour ?minuteBucket
ORDER BY ?dataset ?year ?month ?day ?hour ?minuteBucket
`;
}

async function createService(
  umaFetch: ReturnType<KeycloakOIDCAuth["createUMAFetch"]>,
  name: string,
  metric: string,
  query: string,
  sources: string
): Promise<void> {
  const params = {
    query,
    sources,
    schema: SCHEMA,
    context: CONTEXT,
  };

  const startedAt = Date.now();
  console.log(`=== [${timestamp()}] Creating service "${name}" for metric "${metric}" ===`);
  const desc = await parseServiceRequest(name, TF_ID, params);
  const response = await umaFetch(`${AGGREGATOR}${SVC}`, {
    method: "POST",
    headers: { "content-type": "text/turtle" },
    body: desc,
  });

  console.log(`=== [${timestamp()}] Response status for "${name}": ${response.status} after ${formatDuration(Date.now() - startedAt)} ===`);
  const responseText = await response.text();

  if (CREATED_STATUS_CODES.has(response.status)) {
    console.log(`=== [${timestamp()}] Created "${name}" in ${formatDuration(Date.now() - startedAt)} ===`);
    console.log(responseText);
    return;
  }

  {
    throw new Error(
      `Error creating "${name}": ${response.status}, response: ${responseText}`
    );
  }
}

async function parseServiceRequest(
  name: string,
  id: string,
  params: Record<string, string>
): Promise<string> {
  const writer = new Writer({
    prefixes: {
      trans: `${AGGREGATOR_SERVER}${TF}#`,
      fno: "https://w3id.org/function/ontology#",
      rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
      xsd: "http://www.w3.org/2001/XMLSchema#",
    },
  });

  const execution = df.namedNode(`${AGGREGATOR}/${name}`);

  writer.addQuad(
    execution,
    df.namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type"),
    df.namedNode("https://w3id.org/function/ontology#Execution")
  );

  writer.addQuad(
    execution,
    df.namedNode("https://w3id.org/function/ontology#executes"),
    df.namedNode(`${AGGREGATOR_SERVER}${TF}#${id}`)
  );

  for (const [key, value] of Object.entries(params)) {
    writer.addQuad(
      execution,
      df.namedNode(`${AGGREGATOR_SERVER}${TF}#${key}`),
      df.literal(value)
    );
  }

  return new Promise((resolve, reject) => {
    writer.end((error, result) => {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    });
  });
}

async function main() {
  const totalServices = RAW_SERVICES.length + SAMPLED_SERVICES.length;
  const servicesToCreate = [
    ...RAW_SERVICES.map((definition) => ({
      ...definition,
      query: metricQuery(definition.metric),
    })),
    ...SAMPLED_SERVICES.map((definition) => ({
      ...definition,
      query: sampledMetricQuery(definition.metric),
    })),
  ];
  const selected = selectedKvasirPatientSources();
  const sources = sourceList(selected.sources);

  if (totalServices === 0) {
    throw new Error("No services configured. Add at least one service definition.");
  }

  const runStartedAt = Date.now();
  console.log(`=== [${timestamp()}] Creating services from ${selected.sources.length} Kvasir patient sources ===`);
  if (selected.requested) {
    console.log(`[${timestamp()}] Patient filter: ${selected.requested.join(", ")}`);
  }
  console.log(`[${timestamp()}] Service requestor: ${SERVICE_REQUESTOR}`);
  console.log(`[${timestamp()}] Wait between service creations: ${SERVICE_CREATION_WAIT_MS}ms`);

  const auth = new KeycloakOIDCAuth();
  const credentials = requestorCredentials();
  console.log(`=== [${timestamp()}] Logging in as ${credentials.username} ===`);
  await auth.init(config.idp, config.realm);
  await auth.login(
    credentials.username,
    credentials.password,
    config.clientId,
    config.clientSecret
  );
  console.log(`=== [${timestamp()}] Login completed ===`);

  const umaFetch = auth.createUMAFetch();
  let created = 0;
  const failed: string[] = [];

  for (const [index, { service, metric, query }] of servicesToCreate.entries()) {
    const serviceStartedAt = Date.now();
    try {
      await createService(umaFetch, service, metric, query, sources);
      created++;
    } catch (error) {
      failed.push(service);
      console.error(`=== [${timestamp()}] Failed to create "${service}" after ${formatDuration(Date.now() - serviceStartedAt)}, continuing with next service ===`);
      console.error(error);
    }

    if (index < servicesToCreate.length - 1 && SERVICE_CREATION_WAIT_MS > 0) {
      const nextService = servicesToCreate[index + 1].service;
      console.log(`=== [${timestamp()}] Waiting ${formatDuration(SERVICE_CREATION_WAIT_MS)} before creating "${nextService}" ===`);
      await sleep(SERVICE_CREATION_WAIT_MS);
      console.log(`=== [${timestamp()}] Wait finished ===`);
    }
  }

  console.log(
    `=== [${timestamp()}] Finished ${totalServices} services in ${formatDuration(Date.now() - runStartedAt)} (${created} created, ${failed.length} failed; ${RAW_SERVICES.length} raw, ${SAMPLED_SERVICES.length} sampled) ===`
  );

  if (failed.length > 0) {
    console.error(`=== [${timestamp()}] Failed services: ${failed.join(", ")} ===`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
