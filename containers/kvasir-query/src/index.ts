import { querySources, SparqlJsonResult, EMPTY_RESULT } from "./query.js";
import Fastify from "fastify";
import { Mutex } from "async-mutex";

async function main() {
  console.log("[BOOT] Starting kvasir-query application...");

  const mutex = new Mutex();
  let cachedResult: SparqlJsonResult = EMPTY_RESULT;
  let lastQueryError: string | null = null;

  // =========================
  // ENV VALIDATION
  // =========================
  const SOURCES = process.env.SOURCES;
  if (!SOURCES) throw new Error("Environment variable SOURCES must be set");
  const sources = SOURCES.split(",").map(s => s.trim()).filter(Boolean);
  if (sources.length < 1) throw new Error("Expect at least one source");
  console.log(`[CONFIG] Sources (${sources.length}):`, sources);

  const QUERY = process.env.QUERY;
  if (!QUERY) throw new Error("Environment variable QUERY must be set");

  const SCHEMA = process.env.SCHEMA;
  if (!SCHEMA) throw new Error("Environment variable SCHEMA must be set");

  const CONTEXT = process.env.CONTEXT;
  if (!CONTEXT) throw new Error("Environment variable CONTEXT must be set");

  let context: Record<string, string>;
  try {
    context = JSON.parse(CONTEXT);
  } catch (err) {
    throw new Error(`Failed to parse CONTEXT as JSON: ${err}`);
  }

  // How long to collect results per query cycle before snapshotting (default: 60s).
  // Set lower for faster first results, higher to capture data from slow sources.
  const COLLECTION_TIMEOUT_MS = parseInt(process.env.COLLECTION_TIMEOUT || "60000", 10);

  // How long to wait between the end of one cycle and the start of the next (default: 30s).
  const REFRESH_INTERVAL_MS = parseInt(process.env.REFRESH_INTERVAL || "30000", 10);

  console.log(`[CONFIG] Collection timeout: ${COLLECTION_TIMEOUT_MS}ms, refresh interval: ${REFRESH_INTERVAL_MS}ms`);

  // Re-bind so TypeScript knows these are definitely strings inside closures
  const queryStr: string = QUERY;
  const schemaStr: string = SCHEMA;

  // =========================
  // HTTP SERVER (starts immediately — no waiting for first query)
  // =========================
  const app = Fastify({ logger: false });

  app.get("/", async (request, reply) => {
    console.log(`[HTTP] Incoming request from ${request.ip}`);
    return mutex.runExclusive(async () => {
      if (lastQueryError) {
        console.warn(`[HTTP] Last query had an error: ${lastQueryError}`);
      }
      reply.header("Content-Type", "application/sparql-results+json");
      return cachedResult;
    });
  });

  const port = 3000;
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`[BOOT] Server listening on http://0.0.0.0:${port}`);

  // =========================
  // QUERY CYCLE (background, fires immediately then repeats)
  // =========================
  async function runCycle() {
    console.log("[REFRESH] Starting query cycle...");
    try {
      const result = await querySources(sources, queryStr, schemaStr, context, COLLECTION_TIMEOUT_MS);
      await mutex.runExclusive(() => {
        cachedResult = result;
        lastQueryError = null;
      });
      console.log(`[REFRESH] Cached ${result.results.bindings.length} results`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[REFRESH] Query cycle failed:", msg);
      await mutex.runExclusive(() => { lastQueryError = msg; });
    }

    // Schedule next cycle after the refresh interval
    setTimeout(() => {
      runCycle().catch(err => console.error("[REFRESH] Unhandled error:", err));
    }, REFRESH_INTERVAL_MS);
  }

  // Kick off first cycle immediately (fire-and-forget — server is already up)
  runCycle().catch(err => console.error("[REFRESH] Unhandled error in first cycle:", err));
}

main().catch((err) => {
  console.error("[FATAL] Application crashed:", err);
  process.exit(1);
});
