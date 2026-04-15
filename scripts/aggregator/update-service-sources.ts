import { KeycloakOIDCAuth } from "../util.js";
import { config, aggregatorUrl } from "../config.js";

// ── Script-specific settings ─────────────────────────────────────────────────
const SVC_NAME = config.svcName;
const NEW_SOURCES = [
  `${config.kvasirServer}/alice/slices/AggregatorDemoSlice/query`,
  // `${config.kvasirServer}/bob/slices/AggregatorDemoSlice/query`,
];
// ─────────────────────────────────────────────────────────────────────────────

const SERVICE_ENDPOINT = `${aggregatorUrl}/${SVC_NAME}`;
const SOURCES_ENDPOINT = `${SERVICE_ENDPOINT}/sources`;

async function main() {
  console.log("=== Initializing Keycloak Authentication ===");
  const auth = new KeycloakOIDCAuth();
  await auth.init(config.idp, config.realm);
  await auth.login(config.alice.username, config.alice.password, config.clientId, config.clientSecret);
  console.log("Auth initialized successfully.");
  const umaFetch = auth.createUMAFetch();

  console.log(`\n=== Current sources for '${SVC_NAME}' ===`);
  const getResp = await umaFetch(SOURCES_ENDPOINT, { method: "GET" });
  console.log(`Status: ${getResp.status}`);
  if (!getResp.ok) throw new Error(`Failed to fetch sources: ${await getResp.text()}`);
  const { sources: currentSources } = await getResp.json() as { sources: string[] };
  currentSources.forEach((s, i) => console.log(`  [${i + 1}] ${s}`));

  console.log(`\n=== Overwriting sources for '${SVC_NAME}' ===`);
  const patchResp = await umaFetch(SOURCES_ENDPOINT, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "overwrite", sources: NEW_SOURCES }),
  });
  console.log(`Status: ${patchResp.status}`);
  if (!patchResp.ok) throw new Error(`Failed to update sources: ${await patchResp.text()}`);
  console.log("Sources updated. The service pod is restarting.");

  console.log("\n=== Confirming updated sources ===");
  const confirmResp = await umaFetch(SOURCES_ENDPOINT, { method: "GET" });
  const { sources: updatedSources } = await confirmResp.json() as { sources: string[] };
  updatedSources.forEach((s, i) => console.log(`  [${i + 1}] ${s}`));

  console.log("\n=== Done ===");
}

main().catch(console.error);
