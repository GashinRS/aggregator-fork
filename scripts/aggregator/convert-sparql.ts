import {QueryMapper} from "@comunica-graphql/sparql2graphql-converter/build/converter/queryMapper.js";

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

const context = {
  "saref": "https://saref.etsi.org/core/",
  "void": "http://rdfs.org/ns/void#",
  "protego": "https://dahcc.idlab.ugent.be/Protego/",
  "wear": "https://dahcc.idlab.ugent.be/Homelab/SensorsAndWearables/",
  "act": "https://dahcc.idlab.ugent.be/Homelab/SensorsAndActuators/",
  "saw": "https://dahcc.idlab.ugent.be/Ontology/SensorsAndWearables/",
  "saa": "https://dahcc.idlab.ugent.be/Ontology/SensorsAndActuators/",
  "xsd": "http://www.w3.org/2001/XMLSchema#",
  "kss": "https://kvasir.discover.ilabt.imec.be/vocab#"
};

const sparql = `
PREFIX saref: <https://saref.etsi.org/core/>
PREFIX void: <http://rdfs.org/ns/void#>
PREFIX wear: <https://dahcc.idlab.ugent.be/Homelab/SensorsAndWearables/>

SELECT ?dataset ?timestamp ?value ?source
WHERE {
  {
    SELECT ?dataset (MAX(?ts) AS ?timestamp) WHERE {
      ?o a saref:Observation ;
         saref:observes wear:org.dyamand.types.health.SystolicBloodPressure ;
         saref:hasTimestamp ?ts .
      OPTIONAL { ?o void:inDataset ?dataset . }
    } GROUP BY ?dataset
  }
  ?obs a saref:Observation ;
       saref:observes wear:org.dyamand.types.health.SystolicBloodPressure ;
       saref:hasTimestamp ?timestamp ;
       saref:hasValue ?value .
  OPTIONAL { ?obs void:inDataset ?dataset . }
  OPTIONAL { ?obs saref:madeBy ?source . }
}
ORDER BY ?dataset
`;

// const schema = `
//   type Query {
//     observations: [ex_Observation]!
//     observation(id: ID!): ex_Observation
//   }
//
//   type ex_Patient {
//     id: ID!
//   }
//
//   type ex_Observation {
//     id: ID!
//     ex_value: Int!
//     ex_unit: String!
//     ex_timestamp: DateTime!
//     forPatient: ex_Patient! @predicate(iri: "ex:hasObservation", reverse: true)
//   }
//
//   type Subscription {
//     observationAdded: ex_Observation!
//   }
//
//   type Mutation {
//     add(obs: PatientObservationInput!): ID!
//   }
//
//   input ObservationInput @class(iri: "ex:Observation") {
//     id: ID!
//     ex_value: Int!
//     ex_unit: String!
//     ex_timestamp: DateTime!
//   }
//
//   input PatientObservationInput @class(iri: "ex:Patient") {
//     id: ID!
//     ex_hasObservation: ObservationInput!
//   }
// `;
//
// const context = {
//   kss: "https://kvasir.discover.ilabt.imec.be/vocab#",
//   schema: "http://schema.org/",
//   ex: "http://example.org/",
// };
//
// const sparql = `
//   PREFIX ex: <http://example.org/>
//   SELECT ?pat ?value ?unit ?timestamp
//   WHERE {
//     ?pat ex:hasObservation ?obs .
//     ?obs ex:value ?value ;
//         ex:unit ?unit ;
//         ex:timestamp ?timestamp .
//   }
//   LIMIT 10
// `;



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
