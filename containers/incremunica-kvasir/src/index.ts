import { querySources } from "./query.js";
import Fastify from "fastify";
import { Mutex } from "async-mutex";
import { logMeasurement, viewRowCount } from "./measurement.js";
import { AdditionEvent, LiveResultError, LiveResultStore } from "./live-results.js";
import type { ServerResponse } from "node:http";

const DEFAULT_RESULT_PAGE_SIZE = parseInt(process.env.RESULT_PAGE_SIZE || "25000", 10);
const MAX_RESULT_PAGE_SIZE = parseInt(process.env.RESULT_MAX_PAGE_SIZE || "500000", 10);
const RESULT_SNAPSHOT_TTL_MS = parseInt(process.env.RESULT_SNAPSHOT_TTL_MS || "300000", 10);
const RESULT_MAX_SNAPSHOTS = parseInt(process.env.RESULT_MAX_SNAPSHOTS || "4", 10);
const RESULT_REPLAY_LIMIT = parseInt(process.env.RESULT_REPLAY_LIMIT || "100000", 10);
const RESULT_HEARTBEAT_MS = parseInt(process.env.RESULT_HEARTBEAT_MS || "15000", 10);

function parsePageSize(value: unknown): number {
  const parsed = value === undefined ? DEFAULT_RESULT_PAGE_SIZE : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_RESULT_PAGE_SIZE) {
    throw new LiveResultError(
      `pageSize must be an integer between 1 and ${MAX_RESULT_PAGE_SIZE}`,
      400,
    );
  }
  return parsed;
}

function sseEvent(event: AdditionEvent): string {
  return `id: ${event.sequence}\nevent: add\ndata: ${JSON.stringify(event)}\n\n`;
}

class SseWriter {
  private readonly queue: string[] = [];
  private waitingForDrain = false;
  private closed = false;

  constructor(
    private readonly response: ServerResponse,
    private readonly maxQueuedEvents = 5_000,
  ) {}

  enqueue(value: string): boolean {
    if (this.closed || this.response.destroyed) return false;
    if (this.queue.length >= this.maxQueuedEvents) {
      this.close();
      return false;
    }
    this.queue.push(value);
    this.flush();
    return !this.closed;
  }

  close(): void {
    this.closed = true;
    this.queue.length = 0;
    if (!this.response.destroyed) this.response.destroy();
  }

  private flush(): void {
    if (this.waitingForDrain || this.closed) return;
    while (this.queue.length > 0) {
      const chunk = this.queue.shift()!;
      if (!this.response.write(chunk)) {
        this.waitingForDrain = true;
        this.response.once("drain", () => {
          this.waitingForDrain = false;
          this.flush();
        });
        return;
      }
    }
  }
}

async function main() {
  console.log("[BOOT] Starting application...");

  const mutex = new Mutex();
  const view: Map<string, { bindings: any; count: number }> = new Map();
  const liveResults = new LiveResultStore(
    RESULT_REPLAY_LIMIT,
    RESULT_SNAPSHOT_TTL_MS,
    RESULT_MAX_SNAPSHOTS,
  );
  let initialQueryReady = false;
  let initialQueryRows = 0;

  // =========================
  // ENV VALIDATION
  // =========================
  const SOURCES = process.env.SOURCES;
  if (!SOURCES) {
    console.error("[CONFIG] Missing SOURCES env variable");
    throw new Error("Environment variable SOURCES must be set");
  }
  const sources = SOURCES.split(",");
  console.log(`[CONFIG] Sources loaded (${sources.length}):`, sources);

  if (sources.length < 1) {
    console.error("[CONFIG] No sources provided");
    throw new Error("Expect at least one source");
  }

  const QUERY = process.env.QUERY;
  if (!QUERY) {
    console.error("[CONFIG] Missing QUERY env variable");
    throw new Error("Environment variable QUERY must be set");
  }
  console.log("[CONFIG] Query loaded");

  const SCHEMA = process.env.SCHEMA;
  if (!SCHEMA) {
    console.error("[CONFIG] Missing SCHEMA env variable");
    throw new Error("Environment variable SCHEMA must be set");
  }
  console.log("[CONFIG] Schema loaded");

  const CONTEXT = process.env.CONTEXT;
  if (!CONTEXT) {
    console.error("[CONFIG] Missing CONTEXT env variable");
    throw new Error("Environment variable CONTEXT must be set");
  }

  let context;
  try {
    context = JSON.parse(CONTEXT);
    console.log("[CONFIG] Context parsed successfully");
  } catch (err) {
    console.error("[CONFIG] Failed to parse CONTEXT:", err);
    throw err;
  }

  // =========================
  // QUERY SOURCES
  // =========================
  console.log("[QUERY] Starting querySources...");
  querySources(
    sources,
    QUERY,
    SCHEMA,
    context,
    view,
    mutex,
    (bindings, source, count) => {
      // Initial rows belong to the paginated snapshot, not the live change
      // feed. Once every source has completed its static query, additions are
      // sequenced and retained for reconnect replay.
      if (initialQueryReady) {
        liveResults.recordAddition(bindings, source, count);
      }
    },
    () => {
      initialQueryRows = viewRowCount(view);
      initialQueryReady = true;
      console.log(`[QUERY] Initial materialized view ready (${initialQueryRows} rows)`);
    },
  ).catch((err) => {
    console.error("[QUERY] querySources failed:", err);
  });

  // =========================
  // HTTP SERVER
  // =========================
  const app = Fastify({
    logger: false, // we use console.log manually
  });

  app.get("/", async (request, reply) => {
    const query = request.query as {
      mode?: string;
      after?: string;
      cursor?: string;
      pageSize?: string;
    };

    // This endpoint stays constant-time while the potentially large initial
    // materialized view is being built. Clients use it to avoid repeatedly
    // requesting the actual result.
    if (query.mode === "status") {
      reply.header("Cache-Control", "no-store");
      return {
        ready: initialQueryReady,
        rows: initialQueryReady ? initialQueryRows : null,
        sequence: liveResults.currentSequence(),
      };
    }

    console.log(`[HTTP] Incoming request from ${request.ip}`);

    if (!initialQueryReady) {
      reply.header("Retry-After", "2");
      reply.status(503);
      return {
        error: "Initial materialized view is still loading",
        ready: false,
      };
    }

    if (query.mode === "changes") {
      const afterHeader = request.headers["last-event-id"];
      const afterText = query.after ?? (Array.isArray(afterHeader) ? afterHeader[0] : afterHeader) ?? "0";
      const after = Number(afterText);
      const raw = reply.raw;

      try {
        let closed = false;
        // A client subscribes only after it has downloaded every snapshot page.
        // Additions that arrived during that download are replayed synchronously
        // below to preserve their sequence relative to new live additions. The
        // writer therefore needs room for the bounded replay window plus a small
        // live tail; the previous fixed 5,000-event queue disconnected clients
        // whenever a large snapshot accumulated a larger catch-up backlog.
        const writer = new SseWriter(raw, RESULT_REPLAY_LIMIT + 5_000);
        const subscription = liveResults.subscribe(
          after,
          (event) => !closed && writer.enqueue(sseEvent(event)),
        );

        reply.hijack();
        raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        });
        raw.flushHeaders();

        for (const event of subscription.replay) {
          if (!writer.enqueue(sseEvent(event))) {
            closed = true;
            break;
          }
        }
        // This marker is ordered after every replay event and before any later
        // event-loop turn can publish a new live addition. A client that receives
        // it has caught up from its snapshot sequence and can safely use the
        // current count as its pre-stream baseline.
        if (!closed) {
          if (!writer.enqueue(
            `event: replay-complete\ndata: {"sequence":${liveResults.currentSequence()}}\n\n`,
          )) {
            closed = true;
          }
        }

        const heartbeat = setInterval(() => {
          if (closed || raw.destroyed) return;
          if (!writer.enqueue(`event: heartbeat\ndata: {"sequence":${liveResults.currentSequence()}}\n\n`)) {
            closed = true;
          }
        }, RESULT_HEARTBEAT_MS);

        // An IncomingMessage "close" means that the request has finished being
        // received on current Node versions; it does not reliably mean that the
        // client has closed the long-lived SSE response. Cleaning up there can
        // unsubscribe immediately after the GET request is parsed. The outgoing
        // ServerResponse remains open for the lifetime of the SSE connection, so
        // its "close" event is the correct disconnect signal.
        raw.on("close", () => {
          closed = true;
          writer.close();
          clearInterval(heartbeat);
          subscription.unsubscribe();
        });
        return;
      } catch (err) {
        const status = err instanceof LiveResultError ? err.statusCode : 500;
        reply.status(status);
        return {
          error: err instanceof Error ? err.message : String(err),
          currentSequence: liveResults.currentSequence(),
        };
      }
    }

    return mutex.runExclusive(async () => {
      console.log("[HTTP] Acquired mutex, preparing snapshot page");

      try {
        const started = performance.now();
        const pageSize = parsePageSize(query.pageSize);
        const result = query.cursor
          ? liveResults.nextPage(query.cursor, pageSize)
          : liveResults.firstPage(view, pageSize);
        const serializeMs = Math.round((performance.now() - started) * 1000) / 1000;
        const rows = result.results.bindings.length;
        console.log(`[HTTP] Returning page with ${rows} rows from ${view.size} entries`);
        logMeasurement({
          stage: "service_read",
          event: "http_result_page",
          pod: "all",
          observations: rows,
          request_ip: request.ip,
          view_unique: view.size,
          view_rows: viewRowCount(view),
          result_rows: rows,
          snapshot: result.extensions.pagination.snapshot,
          snapshot_sequence: result.extensions.pagination.snapshotSequence,
          page_complete: result.extensions.pagination.nextCursor === null,
          serialize_ms: serializeMs
        });

        reply.header("Content-Type", "application/sparql-results+json");
        return result;
      } catch (err) {
        console.error("[HTTP] Error while building response:", err);
        logMeasurement({
          stage: "service_read",
          event: "http_error",
          pod: "all",
          observations: viewRowCount(view),
          request_ip: request.ip,
          error: err instanceof Error ? err.message : String(err),
        });
        reply.status(err instanceof LiveResultError ? err.statusCode : 500);
        return { error: "Internal server error" };
      }
    });
  });

  const port = 3000;
  await app.listen({ port, host: "0.0.0.0" });

  console.log(`[BOOT] Server listening on http://0.0.0.0:${port}`);
}

main().catch((err) => {
  console.error("[FATAL] Application crashed:", err);
  process.exit(1);
});
