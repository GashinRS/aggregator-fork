import { KeycloakOIDCAuth } from "../util.js";
import { config, aggregatorUrl } from "../config.js";

// Change SVC_NAME to target a different service instance.
const SVC_NAME = config.svcName;
const SERVICE_ENDPOINT = `${aggregatorUrl}/${SVC_NAME}`;
const OUTPUT_ENDPOINT = `${SERVICE_ENDPOINT}/result`;

async function main() {
  console.log("=== Initializing Keycloak Authentication ===");

  const auth = new KeycloakOIDCAuth();
  await auth.init(config.idp, config.realm);
  await auth.login(config.alice.username, config.alice.password, config.clientId, config.clientSecret);

  console.log("Auth initialized successfully.");
  const umaFetch = auth.createUMAFetch();

  console.log(`\n=== Fetching service config at ${SERVICE_ENDPOINT} ===`);
  try {
    const r = await umaFetch(SERVICE_ENDPOINT, { method: "GET" });
    console.log(`Status: ${r.status}`);
    console.log(await r.text() || "(empty)");
  } catch (err: any) {
    console.error("Failed:", err?.message || err);
  }

  console.log(`\n=== Fetching service results at ${OUTPUT_ENDPOINT} ===`);
  try {
    const r = await umaFetch(OUTPUT_ENDPOINT, { method: "GET" });
    console.log(`Status: ${r.status}`);
    console.log(await r.text() || "(empty)");
  } catch (err: any) {
    console.error("Failed:", err?.message || err);
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
