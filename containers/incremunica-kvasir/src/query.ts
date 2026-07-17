import { QueryEngine } from "@incremunica/query-sparql-incremental";
import { isAddition } from '@incremunica/user-tools';
import { Mutex } from "async-mutex";
import { Agent } from "undici";
import { materializedBindingKey } from "./identity.js";
import { logMeasurement, viewRowCount } from "./measurement.js";
import { copyReplaySnapshot } from "./replay.js";

const DEBUG_STREAM_EVENTS = process.env.DEBUG_STREAM_EVENTS === "1";
const DEBUG_VIEW_EVENTS = process.env.DEBUG_VIEW_EVENTS === "1" || DEBUG_STREAM_EVENTS;
const MEASUREMENT_LOG_INTERVAL_MS = parseInt(process.env.MEASUREMENT_LOG_INTERVAL_MS || "0", 10);
const STREAM_RECONNECT_INITIAL_DELAY_MS = parseInt(process.env.STREAM_RECONNECT_INITIAL_DELAY_MS || "1000", 10);
const STREAM_RECONNECT_MAX_DELAY_MS = parseInt(process.env.STREAM_RECONNECT_MAX_DELAY_MS || "30000", 10);
const STREAM_RECONNECT_BACKOFF_FACTOR = parseFloat(process.env.STREAM_RECONNECT_BACKOFF_FACTOR || "2");
const STREAM_FIRST_DATA_TIMEOUT_MS = parseInt(process.env.STREAM_FIRST_DATA_TIMEOUT_MS || "300000", 10);
const STREAM_REPLAY_SETTLE_MS = parseInt(process.env.STREAM_REPLAY_SETTLE_MS || "30000", 10);
const STREAM_IDLE_TIMEOUT_MS = parseInt(process.env.STREAM_IDLE_TIMEOUT_MS || "120000", 10);
const STATIC_CATCHUP_ENABLED = process.env.STATIC_CATCHUP_ENABLED !== "0";
const STATIC_CATCHUP_ON_RECONNECT = process.env.STATIC_CATCHUP_ON_RECONNECT === "1";
const STATIC_CATCHUP_PAGE_SIZE = parseInt(process.env.STATIC_CATCHUP_PAGE_SIZE || "50000", 10);
const STATIC_CATCHUP_MAX_PAGES = parseInt(process.env.STATIC_CATCHUP_MAX_PAGES || "5000", 10);

const XSD_DATE_TIME = "http://www.w3.org/2001/XMLSchema#dateTime";
const XSD_STRING = "http://www.w3.org/2001/XMLSchema#string";

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
  bindings: Map<string, any>;
  stableKeys: Set<string>;
  settled: boolean;
  closed: boolean;
  settleTimer?: ReturnType<typeof setTimeout>;
}

interface ObservationStaticCatchupPlan {
  metricToken: string;
  metricIri: string;
  graphqlFilterValue: string;
}

interface GraphQLPaginationInfo {
  path?: unknown;
  next?: unknown;
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
  const staticCatchupPlan = STATIC_CATCHUP_ENABLED ? buildObservationStaticCatchupPlan(query, context) : undefined;
  const staticCatchupsInFlight = new Set<string>();
  if (staticCatchupPlan) {
    console.log(`[QUERY] Static catch-up enabled for metric ${staticCatchupPlan.metricToken}`);
  } else if (STATIC_CATCHUP_ENABLED) {
    console.log("[QUERY] Static catch-up unavailable for this query shape; falling back to stream replay");
  }

  const emitViewUpdate = (source?: string, options: { force?: boolean; reason?: string } = {}) => {
    const now = Date.now();
    if (!counters.changedSinceLastLog) return;
    if (!options.force && MEASUREMENT_LOG_INTERVAL_MS > 0 && now - counters.lastLogAt < MEASUREMENT_LOG_INTERVAL_MS) return;

    counters.lastLogAt = now;
    counters.changedSinceLastLog = false;

    logMeasurement({
      stage: "t6",
      event: "view_update",
      pod: source ?? "all",
      observations: source ? (counters.observationsBySource.get(source) ?? 0) : viewRowCount(view),
      source,
      reason: options.reason ?? "stream_delta",
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

  const addSourceContribution = (
    source: string,
    key: string,
    bindings: any,
    count: number,
    stable: boolean,
  ) => {
    if (count <= 0) return 0;

    const entry = view.get(key);
    if (entry) {
      entry.bindings = bindings;
      entry.count = stable ? 1 : entry.count + count;
    } else {
      view.set(key, { bindings, count: stable ? 1 : count });
    }

    const contributions = sourceContributions.get(source) ?? new Map<string, number>();
    contributions.set(key, stable ? 1 : (contributions.get(key) ?? 0) + count);
    sourceContributions.set(source, contributions);

    const addedRows = stable ? 1 : count;
    counters.observationsBySource.set(
      source,
      (counters.observationsBySource.get(source) ?? 0) + addedRows,
    );

    return addedRows;
  };

  const applyReplayProgress = async (
    replay: ReplayState,
    pageEntries: Map<string, { bindings: any; count: number; stable: boolean }>,
    page: number,
  ) => {
    if (pageEntries.size === 0) return;

    await mutex.runExclusive(() => {
      const contributions = sourceContributions.get(replay.source) ?? new Map<string, number>();
      let addedRows = 0;

      for (const [key, pageEntry] of pageEntries) {
        const desiredCount = replay.stableKeys.has(key)
          ? 1
          : (replay.seen.get(key) ?? pageEntry.count);
        const currentCount = contributions.get(key) ?? 0;
        const missingCount = desiredCount - currentCount;

        if (missingCount <= 0) {
          const viewEntry = view.get(key);
          if (viewEntry) {
            viewEntry.bindings = pageEntry.bindings;
            if (pageEntry.stable) {
              viewEntry.count = 1;
            }
          }
          continue;
        }

        addedRows += addSourceContribution(
          replay.source,
          key,
          pageEntry.bindings,
          missingCount,
          pageEntry.stable,
        );
      }

      if (addedRows === 0) return;

      counters.totalAdds += addedRows;
      counters.changedSinceLastLog = true;

      logMeasurement({
        stage: "t6",
        event: "static_catchup_progress",
        pod: replay.source,
        observations: counters.observationsBySource.get(replay.source) ?? 0,
        source: replay.source,
        reconnect_attempt: replay.reconnectAttempt,
        page,
        added_rows: addedRows,
        replay_rows: copyReplaySnapshot(replay.seen).rows,
        view_unique: view.size,
        view_rows: viewRowCount(view),
        total_adds: counters.totalAdds,
        total_removes: counters.totalRemoves,
        source_resets: counters.sourceResets,
      });
      emitViewUpdate(replay.source, { force: true, reason: "static_catchup_progress" });
    });
  };

  const reconcileReplay = async (replay: ReplayState) => {
    if (replay.settled || replay.closed) return;
    replay.settled = true;

    await mutex.runExclusive(() => {
      const replaySnapshot = copyReplaySnapshot(replay.seen);

      if (replaySnapshot.rows === 0) {
        if (DEBUG_VIEW_EVENTS) {
          console.log(`[VIEW] Empty reconnect replay settled for ${replay.source}; keeping current source rows`);
        }
        logMeasurement({
          stage: "t6",
          event: "source_replay_settled",
          pod: replay.source,
          observations: counters.observationsBySource.get(replay.source) ?? 0,
          source: replay.source,
          reconnect_attempt: replay.reconnectAttempt,
          added_rows: 0,
          removed_rows: 0,
          replay_rows: replaySnapshot.rows,
          snapshot_reconciled: false,
          view_unique: view.size,
          view_rows: viewRowCount(view),
          total_adds: counters.totalAdds,
          total_removes: counters.totalRemoves,
          source_resets: counters.sourceResets,
        });
        return;
      }

      const previousContributions = new Map(sourceContributions.get(replay.source) ?? new Map<string, number>());
      let removedRows = 0;

      for (const [key, count] of previousContributions) {
        const desiredCount = replay.seen.get(key) ?? 0;
        if (count <= desiredCount) continue;
        removedRows += removeSourceContribution(replay.source, key, count - desiredCount);
      }

      let addedRows = 0;
      for (const [key, desiredCount] of replay.seen) {
        const currentCount = previousContributions.get(key) ?? 0;
        const bindings = replay.bindings.get(key);
        const stable = replay.stableKeys.has(key);
        const targetCount = stable ? Math.min(desiredCount, 1) : desiredCount;
        if (!bindings) continue;

        if (targetCount > currentCount) {
          addedRows += addSourceContribution(replay.source, key, bindings, targetCount - currentCount, stable);
          continue;
        }

        const entry = view.get(key);
        if (entry) {
          entry.bindings = bindings;
          if (stable) {
            entry.count = 1;
          }
        } else {
          addedRows += addSourceContribution(replay.source, key, bindings, targetCount, stable);
        }
      }

      const reconciledContributions = new Map<string, number>();
      for (const [key, count] of replay.seen) {
        reconciledContributions.set(key, replay.stableKeys.has(key) ? Math.min(count, 1) : count);
      }
      sourceContributions.set(replay.source, reconciledContributions);
      let sourceRows = 0;
      for (const count of reconciledContributions.values()) {
        sourceRows += count;
      }
      counters.observationsBySource.set(replay.source, sourceRows);
      counters.totalAdds += addedRows;
      counters.totalRemoves += removedRows;
      if (addedRows > 0 || removedRows > 0) {
        counters.sourceResets++;
      }
      counters.changedSinceLastLog = true;

      if (DEBUG_VIEW_EVENTS) {
        console.log(`[VIEW] Reconnect replay reconciled for ${replay.source}; added ${addedRows}, removed ${removedRows}`);
      }
      logMeasurement({
        stage: "t6",
        event: "source_replay_reconciled",
        pod: replay.source,
        observations: counters.observationsBySource.get(replay.source) ?? 0,
        source: replay.source,
        reconnect_attempt: replay.reconnectAttempt,
        added_rows: addedRows,
        removed_rows: removedRows,
        replay_rows: replaySnapshot.rows,
        snapshot_reconciled: true,
        view_unique: view.size,
        view_rows: viewRowCount(view),
        total_adds: counters.totalAdds,
        total_removes: counters.totalRemoves,
        source_resets: counters.sourceResets,
      });
      emitViewUpdate(replay.source, { force: true, reason: "snapshot_reconciled" });
    });
  };

  const runStaticCatchup = async (source: typeof sources[number], reconnectAttempt: number) => {
    if (!staticCatchupPlan) return false;
    if (staticCatchupsInFlight.has(source.value)) {
      if (DEBUG_VIEW_EVENTS) {
        console.log(`[STATIC] Catch-up already running for ${source.value}, skipping overlapping run`);
      }
      return false;
    }
    staticCatchupsInFlight.add(source.value);

    const replay: ReplayState = {
      source: source.value,
      reconnectAttempt,
      seen: new Map(),
      bindings: new Map(),
      stableKeys: new Set(),
      settled: false,
      closed: false,
    };

    logMeasurement({
      stage: "t6",
      event: "static_catchup_started",
      pod: source.value,
      observations: counters.observationsBySource.get(source.value) ?? 0,
      source: source.value,
      reconnect_attempt: reconnectAttempt,
      page_size: STATIC_CATCHUP_PAGE_SIZE,
      metric: staticCatchupPlan.metricToken,
    });

    try {
      let cursor: string | undefined;
      let page = 0;
      do {
        page++;
        if (page > STATIC_CATCHUP_MAX_PAGES) {
          throw new Error(`Static catch-up exceeded ${STATIC_CATCHUP_MAX_PAGES} pages`);
        }

        const graphqlQuery = buildObservationStaticCatchupQuery(staticCatchupPlan, cursor);
        const response = await umaProxyFetch(source.value, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            "@context": context,
            query: graphqlQuery,
          }),
        });

        if (!response.ok) {
          throw new Error(`Static catch-up query failed: ${response.status} ${response.statusText}`);
        }

        const body = await response.json() as any;
        if (body.errors) {
          throw new Error(`Static catch-up returned GraphQL errors: ${JSON.stringify(body.errors)}`);
        }

        const observations = Array.isArray(body?.data?.saref_Observation)
          ? body.data.saref_Observation
          : [];
        const pageEntries = new Map<string, { bindings: any; count: number; stable: boolean }>();

        for (const observation of observations) {
          if (!observationMatchesMetric(observation, staticCatchupPlan)) continue;

          const binding = observationToBinding(observation);
          const { key, stable } = materializedBindingKey(binding, source.value);
          replay.seen.set(key, stable ? 1 : (replay.seen.get(key) ?? 0) + 1);
          replay.bindings.set(key, binding);
          if (stable) {
            replay.stableKeys.add(key);
          }
          const currentPageEntry = pageEntries.get(key);
          pageEntries.set(key, {
            bindings: binding,
            count: stable ? 1 : (currentPageEntry?.count ?? 0) + 1,
            stable,
          });
        }

        await applyReplayProgress(replay, pageEntries, page);

        cursor = findNextCursor(body?.extensions?.pagination);
        if (!cursor) {
          console.warn("[STATIC] Page ended without next cursor", {
            page,
            pageRows: observations.length,
            pageSize: STATIC_CATCHUP_PAGE_SIZE,
            extensionKeys: Object.keys(body?.extensions ?? {}),
            pagination: body?.extensions?.pagination,
          });
        }

        logMeasurement({
          stage: "t6",
          event: "static_catchup_page",
          pod: source.value,
          observations: counters.observationsBySource.get(source.value) ?? 0,
          source: source.value,
          reconnect_attempt: reconnectAttempt,
          page,
          page_rows: observations.length,
          replay_rows: replay.seen.size,
          has_next: Boolean(cursor),
        });
      } while (cursor);

      await reconcileReplay(replay);
      logMeasurement({
        stage: "t6",
        event: "static_catchup_completed",
        pod: source.value,
        observations: counters.observationsBySource.get(source.value) ?? 0,
        source: source.value,
        reconnect_attempt: reconnectAttempt,
        pages: page,
        replay_rows: copyReplaySnapshot(replay.seen).rows,
        view_unique: view.size,
        view_rows: viewRowCount(view),
        total_adds: counters.totalAdds,
        total_removes: counters.totalRemoves,
        source_resets: counters.sourceResets,
      });
      return true;
    } catch (err) {
      console.error(`[STATIC] Catch-up failed for ${source.value}:`, err);
      logMeasurement({
        stage: "t6",
        event: "static_catchup_error",
        pod: source.value,
        observations: counters.observationsBySource.get(source.value) ?? 0,
        source: source.value,
        reconnect_attempt: reconnectAttempt,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    } finally {
      staticCatchupsInFlight.delete(source.value);
    }
  };

  const handleBinding = async (b: any, source?: string, replay?: ReplayState) => {
    const { key, stable } = materializedBindingKey(b, source);
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
          activeReplay.seen.set(key, stable ? 1 : (activeReplay.seen.get(key) ?? 0) + 1);
          activeReplay.bindings.set(key, b);
          if (stable) {
            activeReplay.stableKeys.add(key);
          }
          if (DEBUG_VIEW_EVENTS) {
            console.log(`[VIEW] Buffered reconnect replay row for ${source}`);
          }
          return;
        }

        if (stable && sourceCount > 0) {
          const entry = view.get(key);
          if (entry) {
            entry.bindings = b;
            entry.count = 1;
          }
          if (contributions && source) {
            contributions.set(key, 1);
            sourceContributions.set(source, contributions);
          }
          if (DEBUG_VIEW_EVENTS) {
            console.log(`[VIEW] Ignored duplicate stable add for ${source}`);
          }
          return;
        }

        if (view.has(key)) {
          const entry = view.get(key)!;
          if (stable) {
            entry.bindings = b;
            entry.count = 1;
          } else {
            entry.count++;
          }
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
          contributions.set(key, stable ? 1 : sourceCount + 1);
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
      if (staticCatchupPlan && source && !activeReplay) {
        if (DEBUG_VIEW_EVENTS) {
          console.log(`[VIEW] Ignored live stream removal for ${source}; static catch-up owns snapshot reconciliation`);
        }
        return;
      }

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

    const replay: ReplayState | undefined = reconnectAttempt > 0 && !staticCatchupPlan
      ? {
        source: source.value,
        reconnectAttempt,
        seen: new Map(),
        bindings: new Map(),
        stableKeys: new Set(),
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
      void (async () => {
        if (STATIC_CATCHUP_ON_RECONNECT) {
          await runStaticCatchup(source, reconnectAttempt);
        }
        await startSource(source, reconnectAttempt);
      })();
    }, delay);
  };

  if (staticCatchupPlan) {
    await Promise.all(sources.map(source => runStaticCatchup(source, 0)));
  }

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

function buildObservationStaticCatchupPlan(
  sparqlQuery: string,
  context: Record<string, string>,
): ObservationStaticCatchupPlan | undefined {
  if (/\bGROUP\s+BY\b/iu.test(sparqlQuery)) return undefined;
  if (!/\bsaref:Observation\b|\bsaref_Observation\b/iu.test(sparqlQuery) && !/\bsaref:observes\b/iu.test(sparqlQuery)) {
    return undefined;
  }

  const observesMatch = sparqlQuery.match(/\bsaref:observes\s+([^\s;]+)\s*;/iu);
  if (!observesMatch?.[1]) return undefined;

  const metricToken = observesMatch[1].trim();
  const metricIri = expandIriToken(metricToken, context);
  const graphqlFilterValue = compactIriForGraphqlFilter(metricIri, context) ?? metricToken;

  return {
    metricToken,
    metricIri,
    graphqlFilterValue,
  };
}

function buildObservationStaticCatchupQuery(
  plan: ObservationStaticCatchupPlan,
  cursor?: string,
): string {
  const args = [`pageSize: ${STATIC_CATCHUP_PAGE_SIZE}`];
  if (cursor) {
    args.push(`cursor: ${JSON.stringify(cursor)}`);
  }

  return `
query {
  saref_Observation(${args.join(", ")}) {
    id
    saref_hasTimestamp
    saref_hasValue
    void_inDataset
    saref_observes @filter(if: "it==${plan.graphqlFilterValue}")
  }
}
`;
}

function expandIriToken(token: string, context: Record<string, string>): string {
  if (token.startsWith("<") && token.endsWith(">")) {
    return token.slice(1, -1);
  }

  const [prefix, ...localParts] = token.split(":");
  const local = localParts.join(":");
  if (prefix && local && context[prefix]) {
    return `${context[prefix]}${local}`;
  }

  return token;
}

function compactIriForGraphqlFilter(iri: string, context: Record<string, string>): string | undefined {
  for (const [prefix, namespace] of Object.entries(context)) {
    if (iri.startsWith(namespace)) {
      return `${prefix}:${iri.slice(namespace.length)}`;
    }
  }

  return undefined;
}

function observationMatchesMetric(observation: any, plan: ObservationStaticCatchupPlan): boolean {
  const observes = Array.isArray(observation?.saref_observes)
    ? observation.saref_observes
    : observation?.saref_observes
      ? [observation.saref_observes]
      : [];

  return observes.some((value: unknown) => value === plan.metricIri || value === plan.graphqlFilterValue || value === plan.metricToken);
}

function observationToBinding(observation: any): Map<{ value: string }, any> {
  const dataset = firstValue(observation?.void_inDataset);
  const binding = new Map<{ value: string }, any>();

  binding.set({ value: "id" }, namedNode(String(observation.id)));
  binding.set({ value: "dataset" }, namedNode(String(dataset ?? "")));
  binding.set({ value: "timestamp" }, literal(String(observation.saref_hasTimestamp ?? ""), XSD_DATE_TIME));
  binding.set({ value: "value" }, literal(String(observation.saref_hasValue ?? ""), XSD_STRING));

  return binding;
}

function firstValue(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function namedNode(value: string) {
  return {
    termType: "NamedNode",
    value,
  };
}

function literal(value: string, datatype: string) {
  return {
    termType: "Literal",
    value,
    datatype: namedNode(datatype),
    language: "",
  };
}

function findNextCursor(pagination: unknown): string | undefined {
  if (!Array.isArray(pagination)) return undefined;

  const rootPage = pagination.find((page: GraphQLPaginationInfo) => page?.path === "/saref_Observation");
  const candidate = rootPage ?? pagination.find((page: GraphQLPaginationInfo) => typeof page?.next === "string");
  return typeof candidate?.next === "string" ? candidate.next : undefined;
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
