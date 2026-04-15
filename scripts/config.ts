import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Config is read at runtime so you can edit config.json without recompiling.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// __dirname is scripts/dist/ when compiled; go up one level to reach scripts/config.json
const configPath = join(__dirname, "..", "scripts/config.json");

interface UserConfig {
  username: string;
  password: string;
  userId: string;
}

export interface Config {
  /** Base URL of the aggregator server, e.g. https://aggregator.local:5443 */
  aggregatorServer: string;
  /** UUID of your aggregator instance — the part after the server URL */
  aggregatorId: string;
  /** Base URL of the Kvasir/Solid server, e.g. http://localhost:8080 */
  kvasirServer: string;
  /** UMA authorization server URL, e.g. http://localhost:4000/uma */
  asServer: string;
  /** Keycloak IDP base URL */
  idp: string;
  /** Keycloak realm */
  realm: string;
  /** OIDC client ID */
  clientId: string;
  /** OIDC client secret */
  clientSecret: string;
  /** Alice credentials and Keycloak user ID */
  alice: UserConfig;
  /** Bob credentials and Keycloak user ID */
  bob: UserConfig;
  /** Default service name used by aggregator scripts */
  svcName: string;
  /** Shared JSON-LD context for Kvasir queries */
  context: Record<string, string>;
  /** Shared GraphQL schema for Kvasir slices */
  schema: string;
  /** Default SPARQL query run against slices */
  sparqlQuery: string;
}

export const config: Config = JSON.parse(readFileSync(configPath, "utf-8"));

// Convenience derived values

/** Full aggregator instance URL */
export const aggregatorUrl = `${config.aggregatorServer}/${config.aggregatorId}`;

/** UMA ID of a user, following the convention used in this project */
export function umaId(userId: string): string {
  return `http://example.com/id/${userId}`;
}

/** Alice UMA ID */
export const aliceUmaId = umaId(config.alice.userId);

/** Bob UMA ID */
export const bobUmaId = umaId(config.bob.userId);

/** Client UMA ID */
export const clientUmaId = umaId(config.clientId);
