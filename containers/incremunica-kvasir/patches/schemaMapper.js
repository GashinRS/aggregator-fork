"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TypeFieldMapper = exports.RawRDFFieldMapper = exports.ScalarFieldMapper = exports.TypeMapper = exports.SchemaMapper = void 0;
const graphql_1 = require("graphql");
const utils_1 = require("../utils/utils");
const logger_1 = require("../utils/logger");
const trees_1 = require("../utils/trees");
function resolveIRI(iri, fallback, schema) {
    return iri ? schema.replaceSPARQLPrefix(iri) : schema.toSPARQLContext(fallback);
}
function filterFields(fields, node) {
    return fields.filter(field => {
        if (node.type && !field.withType(node.type))
            return false;
        if (!field.withSubject(node.term))
            return false;
        for (const [p, child] of Object.entries(node.children)) {
            if (!field.withPredicate(p, child))
                return false;
        }
        return true;
    });
}
class SchemaMapper {
    constructor(schemaSource, context) {
        this.context = context;
        this.subscriptionFields = {
            "addition": [],
            "deletion": []
        };
        this.queryFields = [];
        this.types = new Map();
        const merged = new Map(SchemaMapper.DEFAULT_PREFIXES);
        for (const [prefix, iri] of Object.entries(context)) {
            merged.set(prefix, iri);
        }
        this.prefixes = Array.from(merged.entries());
        schemaSource = `
      scalar BoxedLiteral
      scalar RDFNode
      scalar DateTime
      scalar Date
      scalar Time
      ${schemaSource}
    `;
        const schema = (0, graphql_1.buildSchema)(schemaSource, { assumeValidSDL: true });
        const subType = schema.getSubscriptionType();
        const queryType = schema.getQueryType();
        if (!subType && !queryType) {
            throw new Error("Schema needs at least a Subscription or Query type");
        }
        for (const type of Object.values((0, utils_1.getCustomObjectTypes)(schema))) {
            const mapper = new TypeMapper(type, this);
            this.types.set(mapper.getIRI(), mapper);
        }
        if (subType) {
            for (const field of Object.values(subType.getFields())) {
                const type = (0, utils_1.getSubscriptionType)(field);
                if (type) {
                    this.subscriptionFields[type].push(FieldMapperFactory.map(field, this));
                }
            }
        }
        if (queryType)
            this.queryFields = Object.values(queryType.getFields())
                .map(f => FieldMapperFactory.map(f, this));
    }
    supportsQuery(node) {
        return filterFields(this.queryFields, node);
    }
    supportsSubscription(node, type) {
        if (!type) {
            return filterFields([...this.subscriptionFields["addition"], ...this.subscriptionFields["deletion"]], node);
        }
        if (type === "addition") {
            return filterFields(this.subscriptionFields["addition"], node);
        }
        return filterFields(this.subscriptionFields["deletion"], node);
    }
    getField(typeIRI, fieldIRI) {
        return this.types.get(typeIRI)?.getField(fieldIRI);
    }
    toGraphQLContext(value) {
        for (const [prefix, ns] of this.prefixes) {
            if (value.startsWith(prefix + ":"))
                return `${prefix}_${value.slice(prefix.length + 1)}`;
            if (value.startsWith(ns))
                return `${prefix}_${value.slice(ns.length)}`;
        }
        throw new Error(`Missing predicate prefix in context: ${value}`);
    }
    toSPARQLContext(value) {
        for (const [prefix, ns] of this.prefixes) {
            if (value.startsWith(prefix + "_"))
                return ns + value.slice(prefix.length + 1);
        }
        return value;
    }
    replaceSPARQLPrefix(value) {
        for (const [prefix, ns] of this.prefixes) {
            if (value.startsWith(prefix + ":"))
                return ns + value.slice(prefix.length + 1);
        }
        return value;
    }
    calculatePossibleTrees(trees) {
        // Collect edges from ALL roots
        const edges = [];
        for (const root of trees.roots) {
            (0, trees_1.collectEdges)(root, edges);
        }
        // Generate all combinations of edge directions
        const combos = edges.reduce((combos, edge) => {
            const variants = this.edgeVariants(edge);
            // If no valid mapping exists → entire combo invalid
            if (!variants.length)
                return [];
            return combos.flatMap(c => variants.map(v => [...c, v]));
        }, [[]]);
        // Rebuild trees and filter only SINGLE ROOT ones
        return combos
            .map(edges => (0, trees_1.buildTrees)(edges))
            .filter(t => t.roots.length === 1)
            .map(t => t.roots[0]);
    }
    getPredicateFields(pred) {
        const fields = [];
        for (const type of this.types.values()) {
            for (const field of type.getFields().values()) {
                if (field.getIRI() === pred)
                    fields.push(field);
            }
        }
        return fields;
    }
    edgeVariants(edge) {
        const fields = this.getPredicateFields(edge.predicate);
        const hasNormal = fields.some(f => !f.reversed);
        const hasReversed = fields.some(f => f.reversed);
        if (!hasNormal && !hasReversed)
            return [];
        const variants = [];
        if (hasNormal)
            variants.push(edge);
        if (hasReversed) {
            variants.push({
                subject: edge.object,
                predicate: edge.predicate,
                object: edge.subject
            });
        }
        return variants;
    }
    rep() {
        return {
            type: "schema",
            types: [...this.types.values()].map(t => t.rep()),
            query: this.queryFields.map(f => f.getName()),
            subscribe: {
                "addition": this.subscriptionFields["addition"].map(f => f.getName()),
                "deletion": this.subscriptionFields["deletion"].map(f => f.getName())
            }
        };
    }
}
exports.SchemaMapper = SchemaMapper;
SchemaMapper.DEFAULT_PREFIXES = [
    ["rdf", "http://www.w3.org/1999/02/22-rdf-syntax-ns#"],
    ["rdfs", "http://www.w3.org/2000/01/rdf-schema#"],
    ["owl", "http://www.w3.org/2002/07/owl#"],
    ["xsd", "http://www.w3.org/2001/XMLSchema#"],
    ["skos", "http://www.w3.org/2004/02/skos/core#"],
    ["dcterms", "http://purl.org/dc/terms/"],
    ["foaf", "http://xmlns.com/foaf/0.1/"],
    ["schema", "https://schema.org/"],
];
class TypeMapper {
    constructor(type, schema) {
        this.fields = new Map();
        const typeIRI = (0, utils_1.getTypeIRI)(type);
        this.iri = typeIRI
            ? schema.replaceSPARQLPrefix(typeIRI)
            : schema.toSPARQLContext(type.name);
        for (const field of Object.values(type.getFields())) {
            const mapper = FieldMapperFactory.map(field, schema);
            this.fields.set(mapper.getIRI(), mapper);
        }
    }
    getIRI() {
        return this.iri;
    }
    getField(iri) {
        return this.fields.get(iri);
    }
    getFields() {
        return this.fields;
    }
    rep() {
        return {
            type: this.iri,
            fields: [...this.fields.values()].map(f => f.rep())
        };
    }
}
exports.TypeMapper = TypeMapper;
class BaseFieldMapper {
    constructor(field, schema) {
        this.field = field;
        const [iri, reversed] = (0, utils_1.getFieldPredicate)(field);
        this.fieldIRI = resolveIRI(iri, field.name, schema);
        this.reversed = reversed;
    }
    getName() {
        return this.field.name;
    }
    getIRI() {
        return this.fieldIRI;
    }
}
class FieldMapperFactory {
    static map(field, schema) {
        const type = (0, graphql_1.getNamedType)(field.type);
        if (!(0, graphql_1.isScalarType)(type))
            return new TypeFieldMapper(field, type, schema);
        if (type.name === "RDFNode" || type.name === "BoxedLiteral")
            return new RawRDFFieldMapper(field, type.name, schema);
        return new ScalarFieldMapper(field, type.name, schema);
    }
}
class ScalarFieldMapper extends BaseFieldMapper {
    constructor(field, type, schema) {
        super(field, schema);
        this.type = type;
    }
    withSubject(obj) {
        if (obj.termType === "Variable")
            return true;
        if (this.type === "ID")
            return obj.termType === "NamedNode";
        return obj.termType === "Literal";
    }
    withPredicate() { return false; }
    withType() { return false; }
    toQuery(node, responseMapper) {
        responseMapper.addContext(this.field.name);
        let query = this.field.name;
        if (node.term.termType === "Variable")
            responseMapper.addVarMapping(node.term.value, this.type);
        else if (node.term.termType === "Literal")
            query += ` @filter(if: "${this.field.name}==${(0, utils_1.valueFromLiteral)(node.term)}")`;
        else if (node.term.termType === "NamedNode") {
            // Best-effort server-side filter (Kvasir may or may not honour this for [ID] fields)
            query += ` @filter(if: "${this.field.name}=='${node.term.value}'")`;
            // Definitive client-side filter: ResponseMapper will discard non-matching resources
            responseMapper.addIDFilter(node.term.value);
        }
        responseMapper.removeContext();
        return query.trim();
    }
    rep() {
        return {
            scalar: this.type,
            reversed: this.reversed,
            graphql: this.getName(),
            sparql: this.getIRI()
        };
    }
}
exports.ScalarFieldMapper = ScalarFieldMapper;
class RawRDFFieldMapper extends BaseFieldMapper {
    constructor(field, type, schema) {
        super(field, schema);
        this.type = type;
    }
    withSubject(obj) {
        return obj.termType !== "NamedNode" || this.type === "RDFNode";
    }
    withPredicate() { return false; }
    withType() { return false; }
    toQuery(node, responseMapper) {
        responseMapper.addContext(this.field.name);
        let query = `${this.field.name} { _rawRDF }`;
        if (node.term.termType === "Variable")
            responseMapper.addVarMapping(node.term.value, this.type, "_rawRDF");
        else if (node.term.termType === "Literal") {
            responseMapper.addFilterMapping({
                "@value": node.term.value,
                "@type": node.term.datatype.value
            });
        }
        else if (node.term.termType === "NamedNode")
            responseMapper.addFilterMapping({ "@id": node.term.value });
        responseMapper.removeContext();
        return query;
    }
    rep() {
        return {
            rdf: this.type,
            reversed: this.reversed,
            graphql: this.getName(),
            sparql: this.getIRI()
        };
    }
}
exports.RawRDFFieldMapper = RawRDFFieldMapper;
class TypeFieldMapper extends BaseFieldMapper {
    constructor(field, fieldType, schemaMapper) {
        super(field, schemaMapper);
        this.schemaMapper = schemaMapper;
        const typeIRI = (0, utils_1.getTypeIRI)(fieldType);
        this.fieldTypeIRI = typeIRI
            ? schemaMapper.replaceSPARQLPrefix(typeIRI)
            : schemaMapper.toSPARQLContext(fieldType.name);
    }
    withType(type) {
        (0, logger_1.getLogger)().debug(`type ${this.fieldTypeIRI} === ${type.value} ? ${this.fieldTypeIRI === type.value}`);
        return this.fieldTypeIRI === type.value;
    }
    withSubject(_subj) {
        return true;
    }
    withPredicate(pred, node) {
        const field = this.schemaMapper.getField(this.fieldTypeIRI, pred);
        if (!field)
            return false;
        if (!field.withSubject(node.term))
            return false;
        if (node.type && !field.withType(node.type))
            return false;
        for (const [p, child] of Object.entries(node.children)) {
            if (!field.withPredicate(p, child))
                return false;
        }
        return true;
    }
    toQuery(node, responseMapper) {
        responseMapper.addContext(this.field.name);
        let query = this.field.name;
        if (Object.keys(node.children).length) {
            if (node.term.termType === "NamedNode")
                query += `(id: "${node.term.value}")`;
            query += " { ";
            if (node.term.termType === "Variable") {
                query += `id `;
                responseMapper.addVarMapping(node.term.value, "ID", "id");
            }
            for (const [pred, child] of Object.entries(node.children)) {
                const field = this.schemaMapper.getField(this.fieldTypeIRI, pred);
                query += field.toQuery(child, responseMapper) + " ";
            }
            query += "}";
        }
        else if (node.term.termType === "Variable") {
            query += " { id }";
            responseMapper.addVarMapping(node.term.value, "ID", "id");
        }
        else if (node.term.termType === "Literal") {
            query += ` @filter(if: "${this.field.name}==${(0, utils_1.valueFromLiteral)(node.term)}")`;
        }
        else if (node.term.termType === "NamedNode") {
            query += `(id: "${node.term.value}") { id }`;
        }
        responseMapper.removeContext();
        return query.trim();
    }
    rep() {
        return {
            type: this.fieldTypeIRI,
            reversed: this.reversed,
            graphql: this.getName(),
            sparql: this.getIRI()
        };
    }
}
exports.TypeFieldMapper = TypeFieldMapper;
//# sourceMappingURL=schemaMapper.js.map