import { QueryEngine } from "@incremunica/query-sparql-incremental";
import { isAddition } from '@incremunica/user-tools';
import { Mutex } from "async-mutex";
import { logMeasurement, viewRowCount } from "./measurement.js";

const DEBUG_STREAM_EVENTS = process.env.DEBUG_STREAM_EVENTS === "1";
const MEASUREMENT_LOG_INTERVAL_MS = parseInt(process.env.MEASUREMENT_LOG_INTERVAL_MS || "1000", 10);

interface StreamCounters {
  totalAdds: number;
  totalRemoves: number;
  changedSinceLastLog: boolean;
  lastLogAt: number;
}

export async function querySources(
  endpoints: string[],
  query: string,
  schema: string,
  context: Record<string, string>,
  view: Map<string,{bindings: any, count: number}>,
  mutex: Mutex
) {
  console.log("[QUERY] Initializing QueryEngine...");
  const engine = new QueryEngine();
  const counters: StreamCounters = {
    totalAdds: 0,
    totalRemoves: 0,
    changedSinceLastLog: false,
    lastLogAt: 0,
  };

  console.log(`[QUERY] Preparing ${endpoints.length} endpoints`);
  const sources = endpoints.map(endpoint => {
    console.log(`[QUERY] Preparing source: ${endpoint}`);
    return {
      value: endpoint,
      type: "graphql",
      context: {
        schema: schema,
        context: context
      }
    }
  });

  const emitViewUpdate = (source?: string) => {
    const now = Date.now();
    if (!counters.changedSinceLastLog) return;
    if (now - counters.lastLogAt < MEASUREMENT_LOG_INTERVAL_MS) return;

    counters.lastLogAt = now;
    counters.changedSinceLastLog = false;

    logMeasurement({
      stage: "t6",
      event: "view_update",
      source,
      view_unique: view.size,
      view_rows: viewRowCount(view),
      total_adds: counters.totalAdds,
      total_removes: counters.totalRemoves,
    });
  };

  const handleBinding = async (b: any, source?: string) => {
    const key = b.toString();
    const addition = isAddition(b);

    if (DEBUG_STREAM_EVENTS) {
      console.log(`[STREAM] ${addition ? "ADD" : "REMOVE"} event: ${key}`);
    }

    if (addition) {
      if (view.has(key)) {
        await mutex.runExclusive(() => {
          const entry = view.get(key)!;
          entry.count++;
          counters.totalAdds++;
          counters.changedSinceLastLog = true;
          console.log(`[VIEW] Incremented count (${entry.count}) for key`);
          emitViewUpdate(source);
        });
      } else {
        await mutex.runExclusive(() => {
          view.set(key, { bindings: b, count: 1 });
          counters.totalAdds++;
          counters.changedSinceLastLog = true;
          console.log("[VIEW] Added new entry with count=1");
          emitViewUpdate(source);
        });
      }
    } else {
      await mutex.runExclusive(() => {
        if (view.has(key)) {
          const existingElement = view.get(key)!;
          existingElement.count--;
          counters.totalRemoves++;
          counters.changedSinceLastLog = true;
          console.log(`[VIEW] Decremented count (${existingElement.count})`);

          if (existingElement.count <= 0) {
            view.delete(key);
            console.log("[VIEW] Entry removed (count <= 0)");
          }
          emitViewUpdate(source);
        } else {
          console.error("[ERROR] Removal received for non-existing key:", key);
        }
      });
    }
  };

  await Promise.all(sources.map(async (source) => {
    console.log(`[QUERY] Executing query for source: ${source.value}`);
    const bindingsStream = await engine.queryBindings(query, {
      sources: <any>[source],
      fetch: umaProxyFetch
    });

    console.log(`[STREAM] Query stream started for source: ${source.value}`);
    logMeasurement({
      stage: "t6",
      event: "stream_started",
      source: source.value,
      source_count: sources.length,
    });

    bindingsStream.on('data', (binding) => {
      void handleBinding(binding, source.value);
    });

    bindingsStream.on('end', () => {
      console.log(`[STREAM] Query stream ended for source: ${source.value}`);
      logMeasurement({
        stage: "t6",
        event: "stream_ended",
        source: source.value,
        view_unique: view.size,
        view_rows: viewRowCount(view),
        total_adds: counters.totalAdds,
        total_removes: counters.totalRemoves,
      });
    });

    bindingsStream.on('error', (err) => {
      console.error(`[STREAM] Error during query execution for ${source.value}:`, err);
      logMeasurement({
        stage: "t6",
        event: "stream_error",
        source: source.value,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }));
}

export function materializedViewToSparqlJson(view: Map<string,{bindings: any, count: number}>) {
  console.log(`[SERIALIZE] Converting materialized view (${view.size} entries)`);

  const variablesSet: Set<string> = new Set();
  const results: {[variableName: string]: {type: string, value: string, datatype?: string, "xml:lang"?: string }}[] = [];

  for (const element of view.values()) {
    for (const variable of element.bindings.keys()) {
      variablesSet.add(variable.value);
    }

    let result: {[variableName: string]: {type: string, value: string, datatype?: string, "xml:lang"?: string }} = {};

    for (const [variable, value] of element.bindings) {
      if (value.termType === 'Literal') {
        result[variable.value] = {
          type: 'literal',
          value: value.value
        };
        if (value.datatype) {
          result[variable.value].datatype = value.datatype.value;
        }
        if (value.language) {
          result[variable.value]["xml:lang"] = value.language;
        }
      } else if (value.termType === 'NamedNode') {
        result[variable.value] = {
          type: 'uri',
          value: value.value
        };
      } else if (value.termType === 'BlankNode') {
        result[variable.value] = {
          type: 'bnode',
          value: value.value
        };
      }
    }

    for (let i = 0; i < element.count; i++) {
      results.push(result);
    }
  }

  console.log(`[SERIALIZE] Generated ${results.length} result rows`);

  return {
    head: { vars: [...variablesSet.keys()] },
    results: { bindings: results },
  };
}

// Retry configuration for UMA permission errors
const RETRY_MAX_ATTEMPTS = parseInt(process.env.UMA_RETRY_MAX_ATTEMPTS || "10", 10);
const RETRY_INITIAL_DELAY_MS = parseInt(process.env.UMA_RETRY_INITIAL_DELAY_MS || "1000", 10);
const RETRY_MAX_DELAY_MS = parseInt(process.env.UMA_RETRY_MAX_DELAY_MS || "30000", 10);
const RETRY_BACKOFF_FACTOR = parseFloat(process.env.UMA_RETRY_BACKOFF_FACTOR || "2");

function isRetryableStatus(status: number): boolean {
  return status === 401 || status === 403;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function umaProxyFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let target = input.toString();
  const originalUrl = target;

  console.log(`[FETCH] Requesting: ${originalUrl}`);

  if (target.startsWith("https")) {
    if (!process.env.HTTPS_PROXY && !process.env.https_proxy) {
      console.log("[FETCH] No HTTPS proxy configured, direct request");
      return fetch(input, init);
    }
    console.log("[FETCH] Using HTTPS proxy");
    target = (process.env.HTTPS_PROXY || process.env.https_proxy) + "/fetch";
  } else {
    if (!process.env.HTTP_PROXY && !process.env.http_proxy) {
      console.log("[FETCH] No HTTP proxy configured, direct request");
      return fetch(input, init);
    }
    console.log("[FETCH] Using HTTP proxy");
    target = (process.env.HTTP_PROXY || process.env.http_proxy) + "/fetch";
  }

  // Prepare headers for the proxy payload
  const bodyHeaders: Record<string, string> = {};
  if (init?.headers) {
    // Copy all headers from init
    if (init.headers instanceof Headers) {
      init.headers.forEach((v, k) => (bodyHeaders[k] = v));
    } else if (Array.isArray(init.headers)) {
      init.headers.forEach(([k, v]) => (bodyHeaders[k] = v));
    } else {
      Object.assign(bodyHeaders, init.headers);
    }
  }

  // If SSE, ensure necessary headers
  const acceptHeader = init?.headers instanceof Headers
    ? init.headers.get("Accept")
    : typeof init?.headers === "object"
      ? (init.headers as Record<string, string>)["Accept"]
      : undefined;

  if (acceptHeader === "text/event-stream") {
    console.log("[FETCH] SSE detected, adding streaming headers to payload");
    bodyHeaders["Accept"] = "text/event-stream";
    bodyHeaders["Cache-Control"] = "no-cache";
    bodyHeaders["Connection"] = "keep-alive";
  }

  const fetchRequest = {
    url: originalUrl,
    method: init?.method || 'GET',
    headers: bodyHeaders,
    body: init?.body ? init.body.toString() : ''
  };

  console.log("[FETCH] Proxy request payload prepared");

  // Retry loop with exponential backoff for UMA permission errors
  let attempt = 0;
  let delay = RETRY_INITIAL_DELAY_MS;

  while (true) {
    const response = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(fetchRequest)
    });

    console.log(`[FETCH] Proxy response received (status: ${response.status}, attempt: ${attempt + 1}/${RETRY_MAX_ATTEMPTS})`);

    if (!isRetryableStatus(response.status) || attempt >= RETRY_MAX_ATTEMPTS - 1) {
      if (isRetryableStatus(response.status)) {
        console.warn(`[FETCH] Giving up after ${attempt + 1} attempts for ${originalUrl} (status: ${response.status})`);
      }

      Object.defineProperty(response, 'url', {
        value: originalUrl,
        writable: false,
        enumerable: true,
        configurable: false
      });

      return response;
    }

    // Retryable error — wait and try again
    console.log(`[FETCH] Permission not yet granted for ${originalUrl}, retrying in ${delay}ms (attempt ${attempt + 1}/${RETRY_MAX_ATTEMPTS})`);
    await sleep(delay);

    attempt++;
    delay = Math.min(delay * RETRY_BACKOFF_FACTOR, RETRY_MAX_DELAY_MS);
  }
}
