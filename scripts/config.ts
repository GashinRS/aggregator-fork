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
  aggregatorServer: "https://aggregator.local:5443",
  aggregatorId: "7a2a2e53-63ad-46cd-bc5b-f3e788c71986",
  kvasirServer: "http://localhost:8080",
  asServer: "http://localhost:4000/uma",
  idp: "http://localhost:8280",
  realm: "kvasir",
  clientId: "demo-client",
  clientSecret: "demo-secret",
  alice: {
    username: "alice",
    password: "alice",
    userId: "ccc3927c-2245-4667-bc9e-b2e800cd4c5f",
  },
  bob: {
    username: "bob",
    password: "bob",
    userId: "d18857bd-1d1d-45c9-a900-05831d582a00",
  },
  svcName: "test",
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

/** Bob UMA ID */
export const bobUmaId = umaId(config.bob.userId);

/** Client UMA ID */
export const clientUmaId = umaId(config.clientId);
