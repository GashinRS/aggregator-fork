interface UserConfig {
  username: string;
  password: string;
  userId: string;
}

export interface Config {
  /** Base URL of the aggregator server, e.g. https://aggregator.local:5443 */
  aggregatorServer: string;
  /** UUID of your aggregator instance — the part after the server URL */
  aggregatorId: string;
  sliceName: string;
  /** Base URL of the Kvasir/Solid server, e.g. http://localhost:8080 */
  kvasirServer: string;
  /** UMA authorization server URL, e.g. http://localhost:4000/uma */
  asServer: string;
  /** Keycloak IDP base URL */
  idp: string;
  /** Keycloak realm */
  realm: string;
  /** OIDC client ID */
  clientId: string;
  /** OIDC client secret */
  clientSecret: string;
  /** Alice credentials and Keycloak user ID */
  alice: UserConfig;
  /** Bob credentials and Keycloak user ID */
  bob: UserConfig;
  patient1: UserConfig;
  patient2: UserConfig;
  patient3: UserConfig;
  patient5: UserConfig;
  patient6: UserConfig;
  patient30: UserConfig;
  /** Default service name used by aggregator scripts */
  svcName: string;
  /** Shared JSON-LD context for Kvasir queries */
  context: Record<string, string>;
  /** Shared GraphQL schema for Kvasir slices */
  schema: string;
  /** Default SPARQL query run against slices */
  sparqlQuery: string;
}

export const config: Config = {
  // aggregatorServer: "https://aggregator.local:5443",
  // aggregatorId: "dc671ab8-e059-4c00-bcb4-cd0cea3c9b95",
  // kvasirServer: "http://localhost:8080",
  // asServer: "http://localhost:4000/uma",
  // idp: "http://localhost:8280",
  aggregatorServer: "https://aggregator.10.10.220.153.sslip.io",
  aggregatorId: "68633ea9-c5b1-4d22-957e-96d2cb128e9f",
  kvasirServer: "http://localhost:8080",
  asServer: "https://10.10.220.153/uma",
  idp: "https://10.10.220.153/auth",
  sliceName: "data",
  realm: "kvasir",
  clientId: "demo-client",
  clientSecret: "demo-secret",
  alice: {
    username: "alice",
    password: "alice",
    userId: "73c92e35-9fb0-4a88-858a-bfe56919baf3",
  },
  bob: {
    username: "bob",
    password: "bob",
    userId: "2c032bd4-77a2-4b15-bba1-c0b7d33e25ad",
  },
  patient1: {
    username: "patient1",
    password: "pass",
    userId: "754d6330-184f-4620-b7ed-c1ec080cd208",
  },
  patient2: {
    username: "patient2",
    password: "patient2",
    userId: "e583a70e-3d6f-45ea-bffc-2a3cd9f58197",
  },
  patient3: {
    username: "patient3",
    password: "pass",
    userId: "e583a70e-3d6f-45ea-bffc-2a3cd9f58197",
  },
  patient5: {
    username: "patient5",
    password: "pass",
    userId: "e583a70e-3d6f-45ea-bffc-2a3cd9f58197",
  },
  patient6: {
    username: "patient6",
    password: "pass",
    userId: "e583a70e-3d6f-45ea-bffc-2a3cd9f58197",
  },
  patient30: {
    username: "patient30",
    password: "pass",
    userId: "e583a70e-3d6f-45ea-bffc-2a3cd9f58197",
  },
  svcName: "wearable-bvp",
  context: {
    kss: "https://kvasir.discover.ilabt.imec.be/vocab#",
    schema: "http://schema.org/",
    ex: "http://example.org/",
  },
  schema:
      "type Query {\n  observations: [ex_Observation]\\!\n}\n\ntype ex_Patient {\n  id: ID\\!\n}\n\ntype ex_Observation {\n  id: ID\\!\n  ex_value: Int\\!\n  ex_unit: String\\!\n  ex_timestamp: DateTime\\!\n  forPatient: ex_Patient\\! @predicate(iri: \"ex:hasObservation\", reverse: true)\n}\n\ntype Subscription {\n  observationAdded: ex_Observation\\!\n}\n\ntype Mutation {\n  addObservation(obs: PatientObservationInput\\!): ID\\!\n}\n\ninput ObservationInput @class(iri: \"ex:Observation\") {\n  id: ID\\!\n  ex_value: Int\\!\n  ex_unit: String\\!\n  ex_timestamp: DateTime\\!\n}\n\ninput PatientObservationInput @class(iri: \"ex:Patient\") {\n  id: ID\\!\n  ex_hasObservation: ObservationInput\\!\n}",
  sparqlQuery:
      "PREFIX ex: <http://example.org/>\nSELECT ?pat ?value ?unit ?timestamp\nWHERE {\n  ?pat ex:hasObservation ?obs .\n  ?obs ex:value ?value ;\n       ex:unit ?unit ;\n       ex:timestamp ?timestamp .\n}",
};

// Convenience derived values

/** Full aggregator instance URL */
export const aggregatorUrl = `${config.aggregatorServer}/${config.aggregatorId}`;

/** UMA ID of a user, following the convention used in this project */
export function umaId(userId: string): string {
  return `http://example.com/id/${userId}`;
}

/** Alice UMA ID */
export const aliceUmaId = umaId(config.alice.userId);

export const patient1UmaId = umaId(config.patient1.userId);
export const patient2UmaId = umaId(config.patient2.userId);

/** Bob UMA ID */
export const bobUmaId = umaId(config.bob.userId);

/** Client UMA ID */
export const clientUmaId = umaId(config.clientId);
