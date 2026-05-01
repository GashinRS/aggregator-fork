"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ResponseMapper = void 0;
const logger_1 = require("../utils/logger");
class ResponseMapper {
    constructor() {
        this.context = [];
        this.varMap = {};
        this.filterMap = {};
        this.typeMap = {};
    }
    addContext(ctx) {
        this.context.push(ctx);
    }
    removeContext() {
        this.context.pop();
    }
    getContext() {
        return this.context.join("_");
    }
    addVarMapping(sparqlVar, type, field) {
        if (field) {
            this.varMap[sparqlVar] = this.getContext() + "_" + field;
            this.typeMap[this.getContext() + "_" + field] = type;
        }
        else {
            this.varMap[sparqlVar] = this.getContext();
            this.typeMap[this.getContext()] = type;
        }
    }
    addFilterMapping(value) {
        this.filterMap[this.getContext() + "__rawRDF"] = value;
    }
    addIDFilter(iri) {
        this.filterMap[this.getContext()] = { '@iri': iri };
    }
    dataToBindings(data, variables, dataFactory, bindingsFactory, prefix = '') {
        function recurse(value, keyPrefix) {
            // Primitive → single resource
            if (typeof value !== 'object' || value === null) {
                return [{ [keyPrefix]: value }];
            }
            // Array → branch resources
            if (Array.isArray(value)) {
                const results = [];
                for (const el of value) {
                    const sub = recurse(el, keyPrefix);
                    results.push(...sub);
                }
                return results;
            }
            // Object → combine fields
            let resources = [{}];
            for (const [key, val] of Object.entries(value)) {
                const fullKey = keyPrefix ? `${keyPrefix}_${key}` : key;
                let fieldResources;
                if (key === '_rawRDF' && typeof val === 'object' && val !== null) {
                    fieldResources = [{ [fullKey]: val }];
                }
                else {
                    fieldResources = recurse(val, fullKey);
                }
                // Cartesian product with existing resources
                const next = [];
                for (const base of resources) {
                    for (const add of fieldResources) {
                        next.push({ ...base, ...add });
                    }
                }
                resources = next;
            }
            return resources;
        }
        return recurse(data, prefix)
            .map(r => this.resourceToBindings(r, variables, dataFactory, bindingsFactory))
            .filter((b) => b !== undefined);
    }
    resourceToBindings(resource, variables, dataFactory, bindingsFactory) {
        (0, logger_1.getLogger)().debug("Resource: ", JSON.stringify(resource, null, 2));
        const bindings = {};
        // --- Filter resources based on filterMap ---
        for (const filterId of Object.keys(this.filterMap)) {
            const filterValue = this.filterMap[filterId];
            const resourceValue = resource[filterId];
            if (filterValue['@iri']) {
                if (resourceValue !== filterValue['@iri']) {
                    // Bound IRI doesn't match, skip resource
                    return undefined;
                }
            }
            else if (filterValue['@id']) {
                if (resourceValue['@id'] !== filterValue['@id']) {
                    // Doesn't match, skip resource
                    return undefined;
                }
            }
            else if (filterValue['@type'] && filterValue['@value'] && (resourceValue['@value'] !== filterValue['@value'] ||
                resourceValue['@type'] !== filterValue['@type'])) {
                // Doesn't match, skip resource
                return undefined;
            }
        }
        // --- Convert resource values to RDF terms ---
        for (const variable of variables) {
            const varName = variable.value;
            const value = resource[this.varMap[varName]];
            const type = this.typeMap[this.varMap[varName]];
            (0, logger_1.getLogger)().debug(`Variable ${varName} maps to ${this.varMap[varName]} = ${value} with type ${type}`);
            bindings[varName] = termFromValue(value, type, dataFactory);
        }
        return bindingsFactory.bindings(Object.entries(bindings).map(([key, term]) => [dataFactory.variable(key), term]));
    }
}
exports.ResponseMapper = ResponseMapper;
function termFromValue(value, type, dataFactory) {
    const XSD = 'http://www.w3.org/2001/XMLSchema#';
    if (type === "ID") {
        return dataFactory.namedNode(value);
    }
    if (type === "BoxedLiteral") {
        const valueType = dataFactory.namedNode(value['@type']);
        return dataFactory.literal(value['@value'], valueType);
    }
    if (type === "RDFNode") {
        if (value['@id']) {
            return dataFactory.namedNode(value['@id']);
        }
        else if (value['@value'] && value['@type']) {
            const valueType = dataFactory.namedNode(value['@type']);
            return dataFactory.literal(value['@value'], valueType);
        }
    }
    if (type === "Int") {
        return dataFactory.literal(value, dataFactory.namedNode(`${XSD}integer`));
    }
    if (type === "Float") {
        // TODO xsd:float xsd:decimal xsd:double
        return dataFactory.literal(value, dataFactory.namedNode(`${XSD}decimal`));
    }
    if (type === 'Boolean') {
        return dataFactory.literal(value ? 'true' : 'false', dataFactory.namedNode(`${XSD}boolean`));
    }
    if (type === "DateTime") {
        return dataFactory.literal(value, dataFactory.namedNode(`${XSD}dateTime`));
    }
    if (type === "Date") {
        return dataFactory.literal(value, dataFactory.namedNode(`${XSD}date`));
    }
    if (type === "Time") {
        return dataFactory.literal(value, dataFactory.namedNode(`${XSD}time`));
    }
    // Default string
    return dataFactory.literal(value.toString(), dataFactory.namedNode(`${XSD}string`));
}
//# sourceMappingURL=responseMapper.js.map
