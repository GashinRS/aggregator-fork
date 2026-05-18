import { QueryEngine } from "@incremunica/query-sparql-incremental";
import { isAddition } from '@incremunica/user-tools';
import { Mutex } from "async-mutex";
import { Agent } from "undici";
import { logMeasurement, viewRowCount } from "./measurement.js";

const DEBUG_STREAM_EVENTS = process.env.DEBUG_STREAM_EVENTS === "1";
const DEBUG_VIEW_EVENTS = process.env.DEBUG_VIEW_EVENTS === "1" || DEBUG_STREAM_EVENTS;
const MEASUREMENT_LOG_INTERVAL_MS = parseInt(process.env.MEASUREMENT_LOG_INTERVAL_MS || "1000", 10);
const STREAM_RECONNECT_INITIAL_DELAY_MS = parseInt(process.env.STREAM_RECONNECT_INITIAL_DELAY_MS || "1000", 10);
const STREAM_RECONNECT_MAX_DELAY_MS = parseInt(process.env.STREAM_RECONNECT_MAX_DELAY_MS || "30000", 10);
const STREAM_RECONNECT_BACKOFF_FACTOR = parseFloat(process.env.STREAM_RECONNECT_BACKOFF_FACTOR || "2");
const STREAM_FIRST_DATA_TIMEOUT_MS = parseInt(process.env.STREAM_FIRST_DATA_TIMEOUT_MS || "300000", 10);
const STREAM_REPLAY_SETTLE_MS = parseInt(process.env.STREAM_REPLAY_SETTLE_MS || "30000", 10);
const STREAM_IDLE_TIMEOUT_MS = parseInt(process.env.STREAM_IDLE_TIMEOUT_MS || "120000", 10);
const STREAM_REPLAY_PRUNE_STALE = process.env.STREAM_REPLAY_PRUNE_STALE === "1";

const streamingDispatcher = new Agent({
  bodyTimeout: 0,
  headersTimeout: 0,
});

interface StreamCounters {
  totalAdds: number;
  totalRemoves: number;
  sourceResets: number;
  changedSinceLastLog: boolean;
  lastLogAt: number;
  observationsBySource: Map<string, number>;
}

interface ReplayState {
  source: string;
  reconnectAttempt: number;
  seen: Map<string, number>;
  settled: boolean;
  closed: boolean;
  settleTimer?: ReturnType<typeof setTimeout>;
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
    sourceResets: 0,
    changedSinceLastLog: false,
    lastLogAt: 0,
    observationsBySource: new Map(),
  };
  const sourceContributions = new Map<string, Map<string, number>>();

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
      pod: source ?? "all",
      observations: source ? (counters.observationsBySource.get(source) ?? 0) : viewRowCount(view),
      source,
      view_unique: view.size,
      view_rows: viewRowCount(view),
      total_adds: counters.totalAdds,
      total_removes: counters.totalRemoves,
      source_resets: counters.sourceResets,
    });
  };

  const removeSourceContribution = (
    source: string,
    key: string,
    count: number,
  ) => {
    const contributions = sourceContributions.get(source);
    const sourceCount = contributions?.get(key) ?? 0;
    if (!contributions || sourceCount <= 0) return 0;

    const removedCount = Math.min(count, sourceCount);
    const entry = view.get(key);
    if (!entry) return 0;

    entry.count -= removedCount;

    if (entry.count <= 0) {
      view.delete(key);
    }

    if (sourceCount <= removedCount) {
      contributions.delete(key);
    } else {
      contributions.set(key, sourceCount - removedCount);
    }

    counters.observationsBySource.set(
      source,
      Math.max(0, (counters.observationsBySource.get(source) ?? 0) - removedCount),
    );

    return removedCount;
  };

  const reconcileReplay = async (replay: ReplayState) => {
    if (replay.settled || replay.closed) return;
    replay.settled = true;

    const contributions = sourceContributions.get(replay.source);
    if (!contributions || contributions.size === 0) return;

    await mutex.runExclusive(() => {
      let removedRows = 0;
      let staleCandidateRows = 0;
      const replayRows = Array.from(replay.seen.values()).reduce((sum, count) => sum + count, 0);

      for (const [key, count] of Array.from(contributions)) {
        const replayCount = replay.seen.get(key) ?? 0;
        if (replayCount >= count) continue;
        staleCandidateRows += count - replayCount;
        if (STREAM_REPLAY_PRUNE_STALE) {
          removedRows += removeSourceContribution(replay.source, key, count - replayCount);
        }
      }

      if (!STREAM_REPLAY_PRUNE_STALE) {
        if (DEBUG_VIEW_EVENTS) {
          console.log(`[VIEW] Reconnect replay settled for ${replay.source}; ${staleCandidateRows} stale candidates kept`);
        }
        logMeasurement({
          stage: "t6",
          event: "source_replay_settled",
          pod: replay.source,
          observations: counters.observationsBySource.get(replay.source) ?? 0,
          source: replay.source,
          reconnect_attempt: replay.reconnectAttempt,
          removed_rows: 0,
          stale_candidate_rows: staleCandidateRows,
          replay_rows: replayRows,
          view_unique: view.size,
          view_rows: viewRowCount(view),
          total_adds: counters.totalAdds,
          total_removes: counters.totalRemoves,
          source_resets: counters.sourceResets,
        });
        return;
      }

      if (removedRows === 0) {
        if (DEBUG_VIEW_EVENTS) {
          console.log(`[VIEW] Reconnect replay settled for ${replay.source}; no stale rows removed`);
        }
        logMeasurement({
          stage: "t6",
          event: "source_replay_settled",
          pod: replay.source,
          observations: counters.observationsBySource.get(replay.source) ?? 0,
          source: replay.source,
          reconnect_attempt: replay.reconnectAttempt,
          removed_rows: 0,
          stale_candidate_rows: staleCandidateRows,
          replay_rows: replayRows,
          view_unique: view.size,
          view_rows: viewRowCount(view),
          total_adds: counters.totalAdds,
          total_removes: counters.totalRemoves,
          source_resets: counters.sourceResets,
        });
        return;
      }

      counters.sourceResets++;
      counters.changedSinceLastLog = true;

      if (DEBUG_VIEW_EVENTS) {
        console.log(`[VIEW] Reconnect replay settled for ${replay.source}; removed ${removedRows} stale rows`);
      }
      logMeasurement({
        stage: "t6",
        event: "source_replay_reconciled",
        pod: replay.source,
        observations: counters.observationsBySource.get(replay.source) ?? 0,
        source: replay.source,
        reconnect_attempt: replay.reconnectAttempt,
        removed_rows: removedRows,
        stale_candidate_rows: staleCandidateRows,
        replay_rows: replayRows,
        view_unique: view.size,
        view_rows: viewRowCount(view),
        total_adds: counters.totalAdds,
        total_removes: counters.totalRemoves,
        source_resets: counters.sourceResets,
      });
    });
  };

  const handleBinding = async (b: any, source?: string, replay?: ReplayState) => {
    const key = b.toString();
    const addition = isAddition(b);
    const activeReplay = replay && !replay.settled && !replay.closed ? replay : undefined;

    if (DEBUG_STREAM_EVENTS) {
      console.log(`[STREAM] ${addition ? "ADD" : "REMOVE"} event: ${key}`);
    }

    if (addition) {
      await mutex.runExclusive(() => {
        const contributions = source ? (sourceContributions.get(source) ?? new Map<string, number>()) : undefined;
        const sourceCount = contributions?.get(key) ?? 0;

        if (activeReplay) {
          activeReplay.seen.set(key, (activeReplay.seen.get(key) ?? 0) + 1);
        }

        if (activeReplay && sourceCount > 0) {
          if (DEBUG_VIEW_EVENTS) {
            console.log(`[VIEW] Reconnect replay confirmed existing source row for ${source}`);
          }
          return;
        }

        if (view.has(key)) {
          const entry = view.get(key)!;
          entry.count++;
          if (DEBUG_VIEW_EVENTS) {
            console.log(`[VIEW] Incremented count (${entry.count}) for key`);
          }
        } else {
          view.set(key, { bindings: b, count: 1 });
          if (DEBUG_VIEW_EVENTS) {
            console.log("[VIEW] Added new entry with count=1");
          }
        }

        if (source && contributions) {
          contributions.set(key, sourceCount + 1);
          sourceContributions.set(source, contributions);
        }
        counters.totalAdds++;
        if (source) {
          counters.observationsBySource.set(source, (counters.observationsBySource.get(source) ?? 0) + 1);
        }
        counters.changedSinceLastLog = true;
        emitViewUpdate(source);
      });
    } else {
      await mutex.runExclusive(() => {
        if (view.has(key)) {
          const removed = source ? removeSourceContribution(source, key, 1) : 0;
          if (!source) {
            const existingElement = view.get(key)!;
            existingElement.count--;
            if (existingElement.count <= 0) {
              view.delete(key);
              if (DEBUG_VIEW_EVENTS) {
                console.log("[VIEW] Entry removed (count <= 0)");
              }
            }
          }
          if (source && removed === 0) {
            console.error("[ERROR] Removal received for key that source did not contribute:", key);
            return;
          }

          counters.totalRemoves++;
          counters.changedSinceLastLog = true;
          if (DEBUG_VIEW_EVENTS) {
            console.log("[VIEW] Removed one source contribution");
          }
          emitViewUpdate(source);
        } else {
          console.error("[ERROR] Removal received for non-existing key:", key);
        }
      });
    }
  };

  const startSource = async (source: typeof sources[number], reconnectAttempt = 0): Promise<void> => {
    console.log(`[QUERY] Executing query for source: ${source.value}`);

    const replay: ReplayState | undefined = reconnectAttempt > 0
      ? {
        source: source.value,
        reconnectAttempt,
        seen: new Map(),
        settled: false,
        closed: false,
      }
      : undefined;

    let bindingsStream;
    try {
      bindingsStream = await engine.queryBindings(query, {
        sources: <any>[source],
        fetch: umaProxyFetch
      });
    } catch (err) {
      console.error(`[STREAM] Failed to start query stream for ${source.value}:`, err);
      logMeasurement({
        stage: "t6",
        event: "stream_start_error",
        pod: source.value,
        observations: counters.observationsBySource.get(source.value) ?? 0,
        source: source.value,
        reconnect_attempt: reconnectAttempt,
        error: err instanceof Error ? err.message : String(err),
      });
      scheduleReconnect(source, reconnectAttempt + 1);
      return;
    }

    console.log(`[STREAM] Query stream started for source: ${source.value}`);
    logMeasurement({
      stage: "t6",
      event: "stream_started",
      pod: source.value,
      observations: counters.observationsBySource.get(source.value) ?? 0,
      source: source.value,
      source_count: sources.length,
      reconnect_attempt: reconnectAttempt,
    });

    let reconnectScheduled = false;
    let firstDataReceived = false;
    let firstDataTimeout: ReturnType<typeof setTimeout> | undefined;
    let idleTimeout: ReturnType<typeof setTimeout> | undefined;

    const clearFirstDataTimeout = () => {
      if (!firstDataTimeout) return;
      clearTimeout(firstDataTimeout);
      firstDataTimeout = undefined;
    };

    const clearIdleTimeout = () => {
      if (!idleTimeout) return;
      clearTimeout(idleTimeout);
      idleTimeout = undefined;
    };

    const clearReplaySettleTimer = () => {
      if (!replay?.settleTimer) return;
      clearTimeout(replay.settleTimer);
      replay.settleTimer = undefined;
    };

    const scheduleReplaySettle = () => {
      if (!replay || STREAM_REPLAY_SETTLE_MS <= 0 || replay.settled || replay.closed) return;
      clearReplaySettleTimer();
      replay.settleTimer = setTimeout(() => {
        replay.settleTimer = undefined;
        void reconcileReplay(replay);
      }, STREAM_REPLAY_SETTLE_MS);
    };

    const destroyStream = (message: string) => {
      const destroy = (bindingsStream as { destroy?: (error?: Error) => void }).destroy;
      if (typeof destroy === "function") {
        destroy.call(bindingsStream, new Error(message));
      }
    };

    const scheduleIdleTimeout = () => {
      if (STREAM_IDLE_TIMEOUT_MS <= 0) return;
      clearIdleTimeout();
      idleTimeout = setTimeout(() => {
        idleTimeout = undefined;
        destroyStream(`Stream idle timeout after ${STREAM_IDLE_TIMEOUT_MS}ms`);
        closeAndReconnect("idle", undefined, STREAM_IDLE_TIMEOUT_MS);
      }, STREAM_IDLE_TIMEOUT_MS);
    };

    const closeAndReconnect = (reason: "end" | "error" | "idle", err?: unknown, idleTimeoutMs = STREAM_FIRST_DATA_TIMEOUT_MS) => {
      if (reconnectScheduled) return;
      reconnectScheduled = true;
      clearFirstDataTimeout();
      clearIdleTimeout();
      clearReplaySettleTimer();
      if (replay) {
        replay.closed = true;
      }

      if (reason === "error") {
        console.error(`[STREAM] Error during query execution for ${source.value}:`, err);
        logMeasurement({
          stage: "t6",
          event: "stream_error",
          pod: source.value,
          observations: counters.observationsBySource.get(source.value) ?? 0,
          source: source.value,
          error: err instanceof Error ? err.message : String(err),
        });
      } else if (reason === "idle") {
        console.warn(`[STREAM] No data received for ${source.value} within ${idleTimeoutMs}ms, reconnecting`);
        logMeasurement({
          stage: "t6",
          event: "stream_idle_timeout",
          pod: source.value,
          observations: counters.observationsBySource.get(source.value) ?? 0,
          source: source.value,
          reconnect_attempt: reconnectAttempt,
          idle_timeout_ms: idleTimeoutMs,
        });
      } else {
        console.log(`[STREAM] Query stream ended for source: ${source.value}`);
        logMeasurement({
          stage: "t6",
          event: "stream_ended",
          pod: source.value,
          observations: counters.observationsBySource.get(source.value) ?? 0,
          source: source.value,
          view_unique: view.size,
          view_rows: viewRowCount(view),
          total_adds: counters.totalAdds,
          total_removes: counters.totalRemoves,
        });
      }

      scheduleReconnect(source, reconnectAttempt + 1);
    };

    bindingsStream.on('data', (binding) => {
      if (!firstDataReceived) {
        firstDataReceived = true;
        clearFirstDataTimeout();
      }
      scheduleIdleTimeout();
      void handleBinding(binding, source.value, replay).then(() => {
        scheduleReplaySettle();
      });
    });

    bindingsStream.on('end', () => {
      closeAndReconnect("end");
    });

    bindingsStream.on('error', (err) => {
      closeAndReconnect("error", err);
    });

    if (STREAM_FIRST_DATA_TIMEOUT_MS > 0) {
      firstDataTimeout = setTimeout(() => {
        destroyStream(`Stream first data timeout after ${STREAM_FIRST_DATA_TIMEOUT_MS}ms`);
        closeAndReconnect("idle");
      }, STREAM_FIRST_DATA_TIMEOUT_MS);
    }
  };

  const scheduleReconnect = (source: typeof sources[number], reconnectAttempt: number) => {
    const delay = Math.min(
      STREAM_RECONNECT_INITIAL_DELAY_MS * Math.pow(STREAM_RECONNECT_BACKOFF_FACTOR, reconnectAttempt - 1),
      STREAM_RECONNECT_MAX_DELAY_MS,
    );

    console.warn(`[STREAM] Reconnecting source ${source.value} in ${delay}ms (attempt ${reconnectAttempt})`);
    logMeasurement({
      stage: "t6",
      event: "stream_reconnect_scheduled",
      pod: source.value,
      observations: counters.observationsBySource.get(source.value) ?? 0,
      source: source.value,
      reconnect_attempt: reconnectAttempt,
      reconnect_delay_ms: delay,
    });

    setTimeout(() => {
      void startSource(source, reconnectAttempt);
    }, delay);
  };

  await Promise.all(sources.map(source => startSource(source)));
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

// Retry configuration for transient UMA/proxy errors
const RETRY_MAX_ATTEMPTS = parseInt(process.env.UMA_RETRY_MAX_ATTEMPTS || "10", 10);
const RETRY_INITIAL_DELAY_MS = parseInt(process.env.UMA_RETRY_INITIAL_DELAY_MS || "1000", 10);
const RETRY_MAX_DELAY_MS = parseInt(process.env.UMA_RETRY_MAX_DELAY_MS || "30000", 10);
const RETRY_BACKOFF_FACTOR = parseFloat(process.env.UMA_RETRY_BACKOFF_FACTOR || "2");

function isRetryableStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 502 || status === 503 || status === 504;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isSseInit(init?: RequestInit): boolean {
  const acceptHeader = init?.headers instanceof Headers
    ? init.headers.get("Accept")
    : typeof init?.headers === "object"
      ? ((init.headers as Record<string, string>)["Accept"] || (init.headers as Record<string, string>)["accept"])
      : undefined;

  return acceptHeader?.includes("text/event-stream") ?? false;
}

function fetchWithOptionalStreamingDispatcher(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!isSseInit(init)) return fetch(input, init);

  return fetch(input, {
    ...init,
    dispatcher: streamingDispatcher,
  } as RequestInit);
}

async function umaProxyFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let target = input.toString();
  const originalUrl = target;

  console.log(`[FETCH] Requesting: ${originalUrl}`);

  if (target.startsWith("https")) {
    if (!process.env.HTTPS_PROXY && !process.env.https_proxy) {
      console.log("[FETCH] No HTTPS proxy configured, direct request");
      return fetchWithOptionalStreamingDispatcher(input, init);
    }
    console.log("[FETCH] Using HTTPS proxy");
    target = (process.env.HTTPS_PROXY || process.env.https_proxy) + "/fetch";
  } else {
    if (!process.env.HTTP_PROXY && !process.env.http_proxy) {
      console.log("[FETCH] No HTTP proxy configured, direct request");
      return fetchWithOptionalStreamingDispatcher(input, init);
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
  const isSseRequest = isSseInit(init);

  if (isSseRequest) {
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
      body: JSON.stringify(fetchRequest),
      ...(isSseRequest ? { dispatcher: streamingDispatcher } : {}),
    } as RequestInit);

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

    console.log(`[FETCH] Retryable proxy response for ${originalUrl}, retrying in ${delay}ms (attempt ${attempt + 1}/${RETRY_MAX_ATTEMPTS}, status: ${response.status})`);
    await sleep(delay);

    attempt++;
    delay = Math.min(delay * RETRY_BACKOFF_FACTOR, RETRY_MAX_DELAY_MS);
  }
}
