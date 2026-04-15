import { QueryEngine } from "@comunica-graphql/query-sparql-graphql";

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
  console.log("[QUERY] Initializing Comunica QueryEngine...");
  const engine = new QueryEngine();

  const sources = endpoints.map(endpoint => {
    console.log(`[QUERY] Adding source: ${endpoint}`);
    return {
      type: "graphql" as const,
      value: endpoint,
      context: { schema, context }
    };
  });

  console.log("[QUERY] Executing query...");
  const bindingsStream = await engine.queryBindings(query, {
    sources: sources as any,
    fetch: umaProxyFetch
  });

  const bindings: any[] = [];
  let settled = false;

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        console.log(`[QUERY] Collection timeout (${collectionTimeoutMs}ms), snapshot has ${bindings.length} results`);
        try { (bindingsStream as any).destroy(); } catch (_) { /* ignore */ }
        resolve();
      }
    }, collectionTimeoutMs);

    bindingsStream.on("data", (b: any) => {
      bindings.push(b);
    });

    bindingsStream.on("end", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        console.log(`[QUERY] Stream ended naturally with ${bindings.length} results`);
        resolve();
      }
    });

    bindingsStream.on("error", (err: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        console.error("[QUERY] Stream error:", err.message);
        resolve();
      }
    });
  });

  return bindingsToSparqlJson(bindings);
}

function bindingsToSparqlJson(bindings: any[]): SparqlJsonResult {
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
