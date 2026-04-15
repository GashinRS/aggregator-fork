import { KeycloakOIDCAuth } from "../util.js";
import { config, aggregatorUrl } from "../config.js";

// Change PATH to query a different endpoint:
//   ""               → aggregator root
//   "/services"      → registered services
//   "/transformations" → available transformations
const PATH = "/transformations";

async function main() {
  console.log("=== Initializing Keycloak Authentication ===");

  const auth = new KeycloakOIDCAuth();
  await auth.init(config.idp, config.realm);
  await auth.login(config.alice.username, config.alice.password, config.clientId, config.clientSecret);

  console.log("Auth initialized successfully.");
  const umaFetch = auth.createUMAFetch();

  const endpoint = aggregatorUrl + PATH;
  console.log(`\n=== Fetching ${endpoint} ===`);

  try {
    const response = await umaFetch(endpoint, { method: "GET" });
    console.log(`Response status: ${response.status}`);
    console.log(await response.text() || "(empty response)");
  } catch (err: any) {
    console.error("Failed:", err?.message || err);
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
