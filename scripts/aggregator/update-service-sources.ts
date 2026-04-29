import { KeycloakOIDCAuth } from "../util.js";
import { config } from "../config.js";

// Aggregator configuration — keep in sync with create-service.ts
const AGGREGATOR_SERVER = "https://aggregator.local:5443";
const AGGREGATOR = `https://aggregator.local:5443/${config.aggregatorId}`;
const SVC_NAME = config.svcName;
const SERVICE_ENDPOINT = `${AGGREGATOR}/${SVC_NAME}`;
const SOURCES_ENDPOINT = `${SERVICE_ENDPOINT}/sources`;

// Authz configuration
const USERNAME = "alice";
const PASSWORD = "alice";
const CLIENT_ID = "demo-client";
const CLIENT_SECRET = config.clientSecret;
const IDP = "http://localhost:8280";
const REALM = "kvasir";

// The new sources to overwrite with. Edit this list to change what the service queries.
const NEW_SOURCES = [
  "http://localhost:8080/alice/slices/AggregatorDemoSlice/query"
  // "http://localhost:8080/bob/slices/AggregatorDemoSlice/query",
];

async function main() {
  console.log("=== Initializing Keycloak Authentication ===");
  const auth = new KeycloakOIDCAuth();
  await auth.init(IDP, REALM);
  await auth.login(USERNAME, PASSWORD, CLIENT_ID, CLIENT_SECRET);
  console.log("🔐 Auth initialized successfully.");
  const umaFetch = auth.createUMAFetch();

  // ── 1. Show current sources ──────────────────────────────────────────────
  console.log(`\n=== Current sources for '${SVC_NAME}' ===`);
  console.log(`➡️  GET ${SOURCES_ENDPOINT}\n`);

  const getResp = await umaFetch(SOURCES_ENDPOINT, { method: "GET" });
  console.log(`📡 Status: ${getResp.status}`);

  if (!getResp.ok) {
    throw new Error(`Failed to fetch sources: ${await getResp.text()}`);
  }

  const { sources: currentSources } = await getResp.json() as { sources: string[] };
  console.log("📋 Current sources:");
  currentSources.forEach((s, i) => console.log(`   [${i + 1}] ${s}`));

  // ── 2. Overwrite with the new list ───────────────────────────────────────
  console.log(`\n=== Overwriting sources for '${SVC_NAME}' ===`);
  console.log(`➡️  PATCH ${SOURCES_ENDPOINT}\n`);

  const body = JSON.stringify({ mode: "overwrite", sources: NEW_SOURCES });

  const patchResp = await umaFetch(SOURCES_ENDPOINT, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body,
  });

  console.log(`📡 Status: ${patchResp.status}`);

  if (!patchResp.ok) {
    throw new Error(`Failed to update sources: ${await patchResp.text()}`);
  }

  console.log("✅ Sources updated. The service pod is restarting with the new configuration.");

  // ── 3. Confirm the new sources ───────────────────────────────────────────
  console.log(`\n=== Confirming updated sources ===`);

  const confirmResp = await umaFetch(SOURCES_ENDPOINT, { method: "GET" });
  const { sources: updatedSources } = await confirmResp.json() as { sources: string[] };
  console.log("📋 New sources:");
  updatedSources.forEach((s, i) => console.log(`   [${i + 1}] ${s}`));

  console.log("\n=== Done ===");
}

main().catch(console.error);