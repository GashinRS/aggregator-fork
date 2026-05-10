import { KeycloakOIDCAuth } from "../util.js";
import { DataFactory } from "rdf-data-factory";
import { Writer } from "n3";
import { config, patient1UmaId } from "../config.js";
import { createPolicies } from "../kvasir/policies.js";
import { KvasirManagement } from "../kvasir/management.js";

const df = new DataFactory();

// Aggregator configuration
const AGGREGATOR_SERVER = "https://aggregator.local:5443";
const AGGREGATOR = `https://aggregator.local:5443/${config.aggregatorId}`;
const TF = "/transformations";
const SVC = "/services";

// Kvasir / UMA configuration
const POD_URL = "http://localhost:8080/patient1";
const AS_SERVER = "http://localhost:4000/uma";
const SLICE_URL = `${POD_URL}/slices/${config.sliceName}`;

// Transformation configuration
const SVC_NAME = config.svcName;
const TF_ID = "IncrementalKvasir";
const PARAMS = {
    query: `
PREFIX saref: <https://saref.etsi.org/core/>
PREFIX void: <http://rdfs.org/ns/void#>
PREFIX wear: <https://dahcc.idlab.ugent.be/Homelab/SensorsAndWearables/>

SELECT ?dataset ?timestamp ?value
WHERE {
 ?obs  saref:observes wear:smartphone.step ;
       saref:hasTimestamp ?timestamp ;
       saref:hasValue ?value ;
       void:inDataset ?dataset .
}
`,
//     query: `
// PREFIX saref: <https://saref.etsi.org/core/>
// PREFIX void: <http://rdfs.org/ns/void#>
// PREFIX wear: <https://dahcc.idlab.ugent.be/Homelab/SensorsAndWearables/>
// PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
//
// SELECT ?dataset ?year ?month ?day ?hour ?minuteBucket (SAMPLE(?timestamp) AS ?timestamp) (SAMPLE(?value) AS ?value)
// WHERE {
//   ?obs saref:observes wear:wearable.gsr ;
//        saref:hasTimestamp ?timestamp ;
//        saref:hasValue ?value ;
//        void:inDataset ?dataset .
//
//   BIND(YEAR(?timestamp) AS ?year)
//   BIND(MONTH(?timestamp) AS ?month)
//   BIND(DAY(?timestamp) AS ?day)
//   BIND(HOURS(?timestamp) AS ?hour)
//   BIND((FLOOR(MINUTES(?timestamp) / 5) * 5) AS ?minuteBucket)
// }
// GROUP BY ?dataset ?year ?month ?day ?hour ?minuteBucket
// ORDER BY ?dataset ?year ?month ?day ?hour ?minuteBucket
// `,
//     query: `
// PREFIX saref: <https://saref.etsi.org/core/>
// PREFIX wear: <https://dahcc.idlab.ugent.be/Homelab/SensorsAndWearables/>
//
// SELECT ?obs ?timestamp ?value ?madeBy
// WHERE {
//   ?obs a saref:Observation ;
//        saref:observes wear:org.dyamand.types.health.SystolicBloodPressure ;
//        saref:hasTimestamp ?timestamp ;
//        saref:hasValue ?value ;
//        saref:madeBy ?madeBy .
// }
// `,
     sources: `http://localhost:8080/patient1/slices/${config.sliceName}/query,http://localhost:8080/patient2/slices/${config.sliceName}/query`,
//    sources: `http://localhost:8080/patient1/slices/${config.sliceName}/query`,
    schema: `
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
  `,
    context: JSON.stringify({
        "saref": "https://saref.etsi.org/core/",
        "void": "http://rdfs.org/ns/void#",
        "protego": "https://dahcc.idlab.ugent.be/Protego/",
        "wear": "https://dahcc.idlab.ugent.be/Homelab/SensorsAndWearables/",
        "act": "https://dahcc.idlab.ugent.be/Homelab/SensorsAndActuators/",
        "saw": "https://dahcc.idlab.ugent.be/Ontology/SensorsAndWearables/",
        "saa": "https://dahcc.idlab.ugent.be/Ontology/SensorsAndActuators/",
        "xsd": "http://www.w3.org/2001/XMLSchema#",
        "kss": "https://kvasir.discover.ilabt.imec.be/vocab#"
    })
};

// Authz configuration
const USERNAME = "patient1";
const PASSWORD = "patient1";
const CLIENT_ID = "demo-client";
const CLIENT_SECRET = config.clientSecret;
const IDP = "http://localhost:8280";
const REALM = "kvasir";

const auth = new KeycloakOIDCAuth()
await auth.init(IDP, REALM)
await auth.login(USERNAME, PASSWORD, CLIENT_ID, CLIENT_SECRET);
const umaFetch = auth.createUMAFetch();

async function createService() {
    console.log(`=== Parsing service request ===`);

    const desc = await parseServiceRequest(SVC_NAME, TF_ID, PARAMS);
    console.log(desc)

    console.log(`=== Creating service at ${AGGREGATOR}${SVC} ===`);

    const serviceRequest = {
        method: "POST",
        headers: { "content-type": "text/turtle" },
        body: desc
    };

    const response = await umaFetch(AGGREGATOR+SVC, serviceRequest);
    console.log(`=== Response status: ${response.status} ===`);

    if (response.status !== 202 && response.status !== 201) {
        throw new Error(`Error: ${response.status}, response: ${await response.text()}`);
    }

    console.log(`=== Service accepted ===`);
    const service = await response.text();
    console.log(service);
}

async function setupUMAPolicies() {
    console.log(`=== Setting up UMA policies for Alice's test slice ===`);

    const kvasir = new KvasirManagement(POD_URL, AS_SERVER);
    await kvasir.init(IDP, REALM);
    await kvasir.login(USERNAME, PASSWORD, CLIENT_ID, CLIENT_SECRET);

    // Delegate Alice's pod to UMA access control (safe to call if already done)
    console.log("▶ Delegating pod to UMA...");
    await kvasir.delegatePodToUMA();

    // Grant Alice (= the aggregator's egress-uma identity) read/write access
    // to the test slice's query and changes endpoints
    console.log("▶ Registering access policies for test slice...");
    const { turtle } = await createPolicies([
        {
            name: "TestSliceOwnerQuery",
            assignee: patient1UmaId,
            assigner: patient1UmaId,
            target: `${SLICE_URL}/query`,
            scopes: ["read", "write"],
        },
        {
            name: "TestSliceOwnerChanges",
            assignee: patient1UmaId,
            assigner: patient1UmaId,
            target: `${SLICE_URL}/changes`,
            scopes: ["read", "write"],
        },
    ]);

    await kvasir.registerPolicies(turtle);
    console.log("✔ UMA policies registered.");
}

async function main() {
    await setupUMAPolicies();
    await createService();
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
        }
    });

    const execution = df.namedNode(`${AGGREGATOR}/${name}`);

    // rdf:type fno:Execution
    writer.addQuad(
        execution,
        df.namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type"),
        df.namedNode("https://w3id.org/function/ontology#Execution")
    );

    // fno:executes trans:$id
    writer.addQuad(
        execution,
        df.namedNode("https://w3id.org/function/ontology#executes"),
        df.namedNode(`${AGGREGATOR_SERVER}${TF}#${id}`)
    );

    // parameters
    for (const [key, value] of Object.entries(params)) {
        writer.addQuad(
            execution,
            df.namedNode(`${AGGREGATOR_SERVER}${TF}#${key}`),
            df.literal(value)
        );
    }

    // Return Turtle string
    return new Promise((resolve, reject) => {
        writer.end((error, result) => {
            if (error) reject(error);
            else resolve(result);
        });
    });
}

main().catch(console.error);
