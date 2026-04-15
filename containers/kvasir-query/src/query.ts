import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// The stock `@comunica-graphql/query-sparql-graphql` engine silently returns an
// empty iterator when a SPARQL query can only be matched through reverse
// predicate mappings. Kvasir slices rely on those mappings, so we execute the
// same SPARQL->GraphQL conversion that the working Incremunica path uses, but
// keep the execution strictly one-shot/non-incremental here.
type VariableLike = { value: string };
type DatatypeLike = { value: string };
type TermLike = {
  termType: string;
  value: string;
  datatype?: DatatypeLike;
  language?: string;
};
type BindingsLike = Iterable<[VariableLike, TermLike]> & {
  keys(): Iterable<VariableLike>;
};

interface ResponseMapperLike {
  dataToBindings(
    data: unknown,
    variables: VariableLike[],
    dataFactory: unknown,
    bindingsFactory: { bindings(entries?: [VariableLike, TermLike][]): BindingsLike }
  ): BindingsLike[];
}

interface QueryMapperLike {
  query(query: string): [string, ResponseMapperLike][];
}

interface QueryMapperCtor {
  new (schema: string, context: Record<string, string>): QueryMapperLike;
}

interface DataFactoryLike {
  variable(value: string): VariableLike;
  namedNode(value: string): DatatypeLike;
  literal(value: string, datatype?: DatatypeLike): TermLike;
}

interface DataFactoryCtor {
  new (): DataFactoryLike;
}

interface BindingsFactoryCtor {
  new (dataFactory: DataFactoryLike): {
    bindings(entries?: [VariableLike, TermLike][]): BindingsLike;
  };
}

type TranslateFn = (query: string) => unknown;
interface SparqlAlgebraUtilLike {
  inScopeVariables(operation: unknown): VariableLike[];
}

const { QueryMapper } = require("@comunica-graphql/sparql2graphql-converter") as {
  QueryMapper: QueryMapperCtor;
};
const { DataFactory } = require("rdf-data-factory") as {
  DataFactory: DataFactoryCtor;
};
const { BindingsFactory } = require("@comunica/utils-bindings-factory") as {
  BindingsFactory: BindingsFactoryCtor;
};
const { translate, Util } = require("sparqlalgebrajs") as {
  translate: TranslateFn;
  Util: SparqlAlgebraUtilLike;
};

export interface SparqlJsonResult {
  head: { vars: string[] };
  results: {
    bindings: { [variableName: string]: { type: string; value: string; datatype?: string; "xml:lang"?: string } }[];
  };
}

export const EMPTY_RESULT: SparqlJsonResult = { head: { vars: [] }, results: { bindings: [] } };

/**
 * Runs a one-shot SPARQL query against Kvasir GraphQL-LD endpoints using Comunica.
 *
 * Unlike incremunica-kvasir, Comunica ends the stream naturally once all results
 * are emitted. The timeout is a safety net for slow or stalling sources.
 */
export async function querySources(
  endpoints: string[],
  query: string,
  schema: string,
  context: Record<string, string>,
  collectionTimeoutMs: number
): Promise<SparqlJsonResult> {
  console.log("[QUERY] Building one-shot GraphQL mappings...");
  const mapper = new QueryMapper(schema, context);
  const candidates = mapper.query(query);
  console.log(`[QUERY] Generated ${candidates.length} GraphQL candidate query/queries`);

  if (candidates.length === 0) {
    console.warn("[QUERY] No executable GraphQL query could be derived from the SPARQL query and schema");
    return EMPTY_RESULT;
  }

  const operation = translate(query);
  const variables = Util.inScopeVariables(operation);
  const dataFactory = new DataFactory();
  const bindingsFactory = new BindingsFactory(dataFactory);

  const allBindings: BindingsLike[] = [];
  for (const endpoint of endpoints) {
    console.log(`[QUERY] Collecting snapshot from ${endpoint}`);
    const endpointBindings = await withTimeout(
      executeAgainstEndpoint(endpoint, candidates, variables, context, dataFactory, bindingsFactory),
      collectionTimeoutMs,
      `Timed out collecting results from ${endpoint} after ${collectionTimeoutMs}ms`
    );
    console.log(`[QUERY] Collected ${endpointBindings.length} bindings from ${endpoint}`);
    allBindings.push(...endpointBindings);
  }

  console.log(`[QUERY] Snapshot contains ${allBindings.length} bindings in total`);
  return bindingsToSparqlJson(allBindings);
}

function bindingsToSparqlJson(bindings: BindingsLike[]): SparqlJsonResult {
  const variablesSet = new Set<string>();
  const results: SparqlJsonResult["results"]["bindings"] = [];

  for (const binding of bindings) {
    for (const variable of binding.keys()) {
      variablesSet.add(variable.value);
    }

    const row: SparqlJsonResult["results"]["bindings"][number] = {};

    for (const [variable, value] of binding) {
      if (value.termType === "Literal") {
        row[variable.value] = { type: "literal", value: value.value };
        if (value.datatype) row[variable.value].datatype = value.datatype.value;
        if (value.language) row[variable.value]["xml:lang"] = value.language;
      } else if (value.termType === "NamedNode") {
        row[variable.value] = { type: "uri", value: value.value };
      } else if (value.termType === "BlankNode") {
        row[variable.value] = { type: "bnode", value: value.value };
      }
    }

    results.push(row);
  }

  return {
    head: { vars: [...variablesSet] },
    results: { bindings: results },
  };
}

async function executeAgainstEndpoint(
  endpoint: string,
  candidates: [string, ResponseMapperLike][],
  variables: VariableLike[],
  context: Record<string, string>,
  dataFactory: DataFactoryLike,
  bindingsFactory: { bindings(entries?: [VariableLike, TermLike][]): BindingsLike }
): Promise<BindingsLike[]> {
  const failures: string[] = [];

  for (const [graphqlQuery, responseMapper] of candidates) {
    try {
      console.log(`[QUERY] Trying candidate query on ${endpoint}: ${graphqlQuery}`);
      return await collectBindings(endpoint, graphqlQuery, responseMapper, variables, context, dataFactory, bindingsFactory);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[QUERY] Candidate query failed on ${endpoint}: ${message}`);
      failures.push(message);
    }
  }

  throw new Error(`All GraphQL query candidates failed for ${endpoint}: ${failures.join(" | ")}`);
}

async function collectBindings(
  endpoint: string,
  initialGraphqlQuery: string,
  responseMapper: ResponseMapperLike,
  variables: VariableLike[],
  context: Record<string, string>,
  dataFactory: DataFactoryLike,
  bindingsFactory: { bindings(entries?: [VariableLike, TermLike][]): BindingsLike }
): Promise<BindingsLike[]> {
  const bindings: BindingsLike[] = [];
  let currentQuery = initialGraphqlQuery;

  while (true) {
    const payload = await executeGraphqlQuery(endpoint, currentQuery, context);
    bindings.push(...responseMapper.dataToBindings(payload.data, variables, dataFactory, bindingsFactory));

    const pagination = getDeepestPagination(payload);
    if (!pagination) {
      break;
    }

    currentQuery = updateQueryCursor(currentQuery, pagination.path, pagination.next);
  }

  return bindings;
}

async function executeGraphqlQuery(
  endpoint: string,
  graphqlQuery: string,
  context: Record<string, string>
): Promise<Record<string, any>> {
  const body = {
    "@context": context,
    query: graphqlQuery,
  };

  const response = await umaProxyFetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await safeReadText(response);
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${text}`);
  }

  const payload = await response.json() as Record<string, any>;
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error(JSON.stringify(payload.errors));
  }

  if (!("data" in payload)) {
    throw new Error("GraphQL response did not contain a data field");
  }

  return payload;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "<failed to read response body>";
  }
}

function getDeepestPagination(payload: Record<string, any>): { path: string; next: string } | null {
  const paginations = payload.extensions?.pagination;
  if (!Array.isArray(paginations)) {
    return null;
  }

  const validPaginations = paginations.filter(
    (pagination: any): pagination is { path: string; next: string } =>
      typeof pagination?.path === "string" &&
      typeof pagination?.next === "string" &&
      pagination.next.length > 0
  );

  if (validPaginations.length === 0) {
    return null;
  }

  return validPaginations.reduce((deepest, current) => {
    const currentDepth = current.path.split("/").filter(Boolean).length;
    const deepestDepth = deepest.path.split("/").filter(Boolean).length;
    return currentDepth > deepestDepth ? current : deepest;
  });
}

function updateQueryCursor(query: string, path: string, newCursor: string): string {
  query = query.trim().slice("query {".length, query.length - 1).trim();
  const pathParts = path.replace(/^\/+/u, "").split("/");

  function insertCursorAtField(source: string, parts: string[]): string {
    const field = parts[0];
    let index = 0;
    let inString = false;

    while (index < source.length) {
      const char = source[index];
      if (char === "\"") {
        inString = !inString;
        index++;
        continue;
      }

      if (!inString && field && new RegExp(`^\\b${field}\\b`, "u").test(source.slice(index))) {
        const matchStart = index;
        const matchEnd = index + field.length;
        let argsStart = -1;
        let argsEnd = -1;
        let bodyStart = -1;

        index = matchEnd;
        while (/\s/u.test(source[index])) {
          index++;
        }

        if (source[index] === "(") {
          argsStart = index;
          let parenCount = 1;
          index++;
          while (index < source.length && parenCount > 0) {
            if (source[index] === "(") {
              parenCount++;
            } else if (source[index] === ")") {
              parenCount--;
            }
            index++;
          }
          argsEnd = index;
        }

        while (/\s/u.test(source[index])) {
          index++;
        }

        if (source[index] === "{") {
          bodyStart = index;
        }

        if (parts.length === 1) {
          let updatedField = "";
          if (argsStart === -1) {
            updatedField = `${field}(cursor: "${newCursor}") `;
          } else {
            const args = source
              .slice(argsStart + 1, argsEnd - 1)
              .split(",")
              .map(arg => arg.trim())
              .filter(arg => arg && !arg.startsWith("cursor:"));
            args.push(`cursor: "${newCursor}"`);
            updatedField = `${field}(${args.join(", ")})`;
          }

          return source.slice(0, matchStart) + updatedField + source.slice(index);
        }

        if (bodyStart !== -1) {
          let braceCount = 1;
          let bodyEnd = bodyStart + 1;
          while (bodyEnd < source.length && braceCount > 0) {
            if (source[bodyEnd] === "{") {
              braceCount++;
            } else if (source[bodyEnd] === "}") {
              braceCount--;
            }
            bodyEnd++;
          }

          const before = source.slice(0, bodyStart + 1);
          const body = source.slice(bodyStart + 1, bodyEnd - 1);
          const after = source.slice(bodyEnd - 1);
          const newBody = insertCursorAtField(body, parts.slice(1));
          return before + newBody + after;
        }
      }

      index++;
    }

    throw new Error(`Unable to update query with cursor ${newCursor} at path ${path}`);
  }

  return `query { ${insertCursorAtField(query, pathParts)} }`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
}

// UMA Proxy Fetch
// Routes requests through an egress UMA proxy if HTTP_PROXY / HTTPS_PROXY is set.
// Retries on 401/403 with exponential backoff while the UMA permission flow completes.

const RETRY_MAX_ATTEMPTS = parseInt(process.env.UMA_RETRY_MAX_ATTEMPTS ?? "10", 10);
const RETRY_INITIAL_DELAY_MS = parseInt(process.env.UMA_RETRY_INITIAL_DELAY_MS ?? "1000", 10);
const RETRY_MAX_DELAY_MS = parseInt(process.env.UMA_RETRY_MAX_DELAY_MS ?? "30000", 10);
const RETRY_BACKOFF_FACTOR = parseFloat(process.env.UMA_RETRY_BACKOFF_FACTOR ?? "2");

function isRetryableStatus(status: number): boolean {
  return status === 401 || status === 403;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function umaProxyFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const originalUrl = input.toString();
  let target = originalUrl;

  console.log(`[FETCH] Requesting: ${originalUrl}`);

  if (target.startsWith("https")) {
    const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
    if (!proxy) return fetch(input, init);
    target = proxy + "/fetch";
  } else {
    const proxy = process.env.HTTP_PROXY ?? process.env.http_proxy;
    if (!proxy) return fetch(input, init);
    target = proxy + "/fetch";
  }

  const bodyHeaders: Record<string, string> = {};
  if (init?.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((v, k) => { bodyHeaders[k] = v; });
    } else if (Array.isArray(init.headers)) {
      for (const [k, v] of init.headers) bodyHeaders[k] = v;
    } else {
      Object.assign(bodyHeaders, init.headers);
    }
  }

  const fetchRequest = {
    url: originalUrl,
    method: init?.method ?? "GET",
    headers: bodyHeaders,
    body: init?.body ? String(init.body) : ""
  };

  let attempt = 0;
  let delay = RETRY_INITIAL_DELAY_MS;

  while (true) {
    const response = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fetchRequest)
    });

    console.log(`[FETCH] Status: ${response.status} (attempt ${attempt + 1}/${RETRY_MAX_ATTEMPTS})`);

    if (!isRetryableStatus(response.status) || attempt >= RETRY_MAX_ATTEMPTS - 1) {
      if (isRetryableStatus(response.status)) {
        console.warn(`[FETCH] Giving up after ${attempt + 1} attempts for ${originalUrl}`);
      }
      Object.defineProperty(response, "url", {
        value: originalUrl, writable: false, enumerable: true, configurable: false
      });
      return response;
    }

    console.log(`[FETCH] Retrying in ${delay}ms (permission not yet granted)`);
    await sleep(delay);
    attempt++;
    delay = Math.min(delay * RETRY_BACKOFF_FACTOR, RETRY_MAX_DELAY_MS);
  }
}
