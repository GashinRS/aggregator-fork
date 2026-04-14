import { KeycloakOIDCAuth } from "../util.js";

// Authz configuration
const USERNAME = "alice";
const PASSWORD = "alice";
const CLIENT_ID = "demo-client";
const CLIENT_SECRET = "BtAllQkmYBKNWsImCv5jDLvyh6hjKE2y";
const IDP = "http://localhost:8280";
const REALM = "quarkus";

// Aggregator configuration
const AGGREGATOR = "https://aggregator.local:5443/cdbb9953-a32f-4042-b571-e43cbfb8c0ca"
const SERVICE_ENDPOINT = `${AGGREGATOR}/test1`;
const OUTPUT_ENDPOINT = `${SERVICE_ENDPOINT}/result`;

async function main() {
  console.log("=== Initializing Keycloak Authentication ===");

  const auth = new KeycloakOIDCAuth();
  await auth.init(IDP, REALM);
  await auth.login(USERNAME, PASSWORD, CLIENT_ID, CLIENT_SECRET);

  
  console.log("🔐 Auth initialized successfully.");
  const umaFetch = auth.createUMAFetch();

  console.log("\n=== Fetching service config ===");
  console.log(`➡️  Endpoint: ${SERVICE_ENDPOINT}\n`);

  try {
    const response = await umaFetch(SERVICE_ENDPOINT, { method: "GET" });

    console.log(`📡 Response status: ${response.status}`);
    console.log("📄 Response body:\n");

    const bodyText = await response.text();
    console.log(bodyText || "(empty response)");
  } catch (err: any) {
    console.error("\n❌ Failed to fetch service config:");
    console.error(err?.message || err);
  }

  console.log("\n=== Fetching service results ===");
  console.log(`➡️  Endpoint: ${OUTPUT_ENDPOINT}\n`);

  try {
    const response = await umaFetch(OUTPUT_ENDPOINT, { method: "GET" });

    console.log(`📡 Response status: ${response.status}`);
    console.log("📄 Response body:\n");

    const bodyText = await response.text();
    console.log(bodyText || "(empty response)");
  } catch (err: any) {
    console.error("\n❌ Failed to fetch service result:");
    console.error(err?.message || err);
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
