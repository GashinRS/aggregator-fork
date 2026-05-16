import { KeycloakOIDCAuth } from "../util.js";
import { DataFactory } from "rdf-data-factory";
import { Writer } from "n3";
import { config } from "../config.js";
import { kvasirPatientSources } from "./kvasir-patients.js";

const df = new DataFactory();

const AGGREGATOR_SERVER = config.aggregatorServer;
const AGGREGATOR = `${config.aggregatorServer}/${config.aggregatorId}`;
const TF = "/transformations";
const SVC = "/services";
const TF_ID = "IncrementalKvasir";
const CREATED_STATUS_CODES = new Set([201, 202]);

type ServiceDefinition = {
  service: string;
  metric: string;
};

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

const KVASIR_CLIENT_SOURCES = kvasirPatientSources();

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

const SOURCES = KVASIR_CLIENT_SOURCES
  .map(({ client, server }) => `${withoutTrailingSlash(server)}/${client}/slices/${config.sliceName}/query`)
  .join(",");

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
  query: string
): Promise<void> {
  const params = {
    query,
    sources: SOURCES,
    schema: SCHEMA,
    context: CONTEXT,
  };

  console.log(`=== Creating service "${name}" for metric "${metric}" ===`);
  const desc = await parseServiceRequest(name, TF_ID, params);
  const response = await umaFetch(`${AGGREGATOR}${SVC}`, {
    method: "POST",
    headers: { "content-type": "text/turtle" },
    body: desc,
  });

  console.log(`=== Response status for "${name}": ${response.status} ===`);
  const responseText = await response.text();

  if (CREATED_STATUS_CODES.has(response.status)) {
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

  if (totalServices === 0) {
    throw new Error("No services configured. Add at least one service definition.");
  }

  const auth = new KeycloakOIDCAuth();
  await auth.init(config.idp, config.realm);
  await auth.login(
    config.patient1.username,
    config.patient1.password,
    config.clientId,
    config.clientSecret
  );

  const umaFetch = auth.createUMAFetch();
  let created = 0;
  const failed: string[] = [];

  for (const { service, metric } of RAW_SERVICES) {
    try {
      await createService(umaFetch, service, metric, metricQuery(metric));
      created++;
    } catch (error) {
      failed.push(service);
      console.error(`=== Failed to create "${service}", continuing with next service ===`);
      console.error(error);
    }
  }

  for (const { service, metric } of SAMPLED_SERVICES) {
    try {
      await createService(umaFetch, service, metric, sampledMetricQuery(metric));
      created++;
    } catch (error) {
      failed.push(service);
      console.error(`=== Failed to create "${service}", continuing with next service ===`);
      console.error(error);
    }
  }

  console.log(
    `=== Finished ${totalServices} services (${created} created, ${failed.length} failed; ${RAW_SERVICES.length} raw, ${SAMPLED_SERVICES.length} sampled) ===`
  );

  if (failed.length > 0) {
    console.error(`=== Failed services: ${failed.join(", ")} ===`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
