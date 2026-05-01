import { createRequire } from "module";

const require = createRequire(import.meta.url);

const { QueryMapper } = require(
  "@comunica-graphql/sparql2graphql-converter/build/converter/queryMapper.js"
);

const schema = `
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
  saref_ObservationRemoved: saref_Observation!
}
`;

const context = {
  saref: "https://saref.etsi.org/core/",
  void: "http://rdfs.org/ns/void#",
  protego: "https://dahcc.idlab.ugent.be/Protego/data/",
  wear: "https://dahcc.idlab.ugent.be/Homelab/SensorsAndWearables/",
  act: "https://dahcc.idlab.ugent.be/Homelab/SensorsAndActuators/",
  saw: "https://dahcc.idlab.ugent.be/Ontology/SensorsAndWearables/",
  saa: "https://dahcc.idlab.ugent.be/Ontology/SensorsAndActuators/",
  xsd: "http://www.w3.org/2001/XMLSchema#",
  kss: "https://kvasir.discover.ilabt.imec.be/vocab#",
};

const sparql = `
PREFIX saref: <https://saref.etsi.org/core/>
PREFIX wear: <https://dahcc.idlab.ugent.be/Homelab/SensorsAndWearables/>

SELECT ?obs ?timestamp ?value
WHERE {
  ?obs saref:observes wear:org.dyamand.types.health.SystolicBloodPressure ;
       saref:hasTimestamp ?timestamp ;
       saref:hasValue ?value .
}
`;

const mapper = new QueryMapper(schema, context);

function printConversion(
  label: string,
  convert: () => Array<[string, unknown]>
): void {
  console.log(`\n=== ${label} ===`);

  try {
    const conversions = convert();

    if (conversions.length === 0) {
      console.log("(no conversion)");
      return;
    }

    conversions.forEach(([query], index) => {
      console.log(`\n--- option ${index + 1} ---`);
      console.log(query);
    });
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
  }
}

printConversion("Initial GraphQL query", () => mapper.query(sparql));
printConversion("Addition subscription", () =>
  mapper.subscribe(sparql, "addition")
);
printConversion("Deletion subscription", () =>
  mapper.subscribe(sparql, "deletion")
);
