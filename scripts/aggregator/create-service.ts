import { KeycloakOIDCAuth } from "../util.js";
import { DataFactory } from "rdf-data-factory";
import { Writer } from "n3";
import { config, aggregatorUrl } from "../config.js";

const df = new DataFactory();

const AGGREGATOR_SERVER = config.aggregatorServer;
const AGGREGATOR = aggregatorUrl;
const TF = "/transformations";
const SVC = "/services";

// ── Script-specific settings ─────────────────────────────────────────────────
// Change these without touching config.json (they vary per invocation).
const SVC_NAME = config.svcName;
const TF_ID = "KvasirQuery";
const PARAMS = {
  query: config.sparqlQuery,
  sources: [
    `${config.kvasirServer}/alice/slices/AggregatorDemoSlice/query`,
    `${config.kvasirServer}/bob/slices/AggregatorDemoSlice/query`,
  ].join(","),
  schema: config.schema,
  context: JSON.stringify(config.context),
};
// ─────────────────────────────────────────────────────────────────────────────

const auth = new KeycloakOIDCAuth();
await auth.init(config.idp, config.realm);
await auth.login(config.alice.username, config.alice.password, config.clientId, config.clientSecret);
const umaFetch = auth.createUMAFetch();

async function createService() {
    console.log(`=== Parsing service request ===`);

    const desc = await parseServiceRequest(SVC_NAME, TF_ID, PARAMS);
    console.log(desc);

    console.log(`=== Creating service at ${AGGREGATOR}${SVC} ===`);

    const response = await umaFetch(AGGREGATOR + SVC, {
        method: "POST",
        headers: { "content-type": "text/turtle" },
        body: desc,
    });
    console.log(`=== Response status: ${response.status} ===`);

    if (response.status !== 202 && response.status !== 201) {
        throw new Error(`Error: ${response.status}, response: ${await response.text()}`);
    }

    console.log(`=== Service accepted ===`);
    console.log(await response.text());
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
    writer.end((error, result) => (error ? reject(error) : resolve(result)));
  });
}

await createService().catch(console.error);
