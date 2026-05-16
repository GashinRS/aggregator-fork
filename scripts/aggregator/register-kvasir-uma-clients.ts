import { readFile, writeFile } from "node:fs/promises";
import { config } from "../config.js";
import {
  DEFAULT_KVASIR_PATIENT_COUNT,
  DEFAULT_PATIENT_PASSWORD,
  kvasirPatientSources,
} from "./kvasir-patients.js";
import { KeycloakOIDCAuth } from "../util.js";

type UserCredentials = {
  username: string;
  password: string;
};

type UmaRegistrationResponse = {
  client_uri: string;
  client_name?: string;
  client_id: string;
  client_secret: string;
  client_secret_expires_at: string;
  grant_types: string[];
  token_endpoint_auth_method: string;
};

type StoredClientCredentials = {
  patient: string;
  podUrl: string;
  umaServerUrl: string;
  clientUri: string;
  clientName: string;
  clientId: string;
  clientSecret: string;
  clientSecretExpiresAt: string;
  grantTypes: string[];
  tokenEndpointAuthMethod: string;
  principalExtractor: string;
  extractorConfig: Record<string, string>;
  allowedSkewSeconds: number;
  registeredAt: string;
};

type KvasirUmaConfig = {
  "server-url": string;
  "client-id": string;
  "client-secret": string;
  "principal-extractor": {
    "class-name": string;
    config: Record<string, string>;
  };
  "jwt-allowed-clock-skew-seconds": number;
};

type KvasirPodConfiguration = {
  auth?: {
    uma?: KvasirUmaConfig | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

type CredentialsFile = {
  umaSettings: {
    enabled: true;
    serverUrl: string;
    principalExtractor: string;
    extractorConfig: Record<string, string>;
    allowedSkewSeconds: number;
  };
  clients: Record<string, StoredClientCredentials>;
};

const UMA_SERVER_URL = withoutTrailingSlash(
  process.env.KVASIR_UMA_SERVER_URL ?? "https://10.10.220.153/uma/uma"
);
const OUTPUT_PATH =
  process.env.KVASIR_UMA_CREDENTIALS_OUT ?? "uma-patient-client-credentials.local.json";
const PRINCIPAL_EXTRACTOR =
  "kvasir.plugins.policyagent.openfga.extractors.SimpleJWTPrincipalExtractor";
const EXTRACTOR_CONFIG = { "attribute-name": "jti" };
const ALLOWED_SKEW_SECONDS = 30;
const APPLY_KVASIR_SETTINGS = process.env.KVASIR_APPLY_UMA_SETTINGS !== "false";

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function configuredCredentials(user: string): UserCredentials | undefined {
  const maybeConfig = (config as unknown as Record<string, Partial<UserCredentials>>)[user];
  if (typeof maybeConfig?.username !== "string") {
    return undefined;
  }

  return {
    username: maybeConfig.username,
    password:
      typeof maybeConfig.password === "string"
        ? maybeConfig.password
        : DEFAULT_PATIENT_PASSWORD,
  };
}

function credentialsFor(user: string): UserCredentials {
  return {
    username: configuredCredentials(user)?.username ?? user,
    password: configuredCredentials(user)?.password ?? DEFAULT_PATIENT_PASSWORD,
  };
}

async function readCredentialsFile(): Promise<CredentialsFile> {
  const empty: CredentialsFile = {
    umaSettings: {
      enabled: true,
      serverUrl: UMA_SERVER_URL,
      principalExtractor: PRINCIPAL_EXTRACTOR,
      extractorConfig: EXTRACTOR_CONFIG,
      allowedSkewSeconds: ALLOWED_SKEW_SECONDS,
    },
    clients: {},
  };

  try {
    const raw = await readFile(OUTPUT_PATH, "utf8");
    const parsed = JSON.parse(raw) as CredentialsFile;
    return {
      ...empty,
      ...parsed,
      umaSettings: empty.umaSettings,
      clients: parsed.clients ?? {},
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return empty;
    }
    throw error;
  }
}

async function fetchRegistrationEndpoint(): Promise<string> {
  const response = await fetch(`${UMA_SERVER_URL}/.well-known/uma2-configuration`, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch UMA configuration from ${UMA_SERVER_URL}: ${response.status} ${await response.text()}`
    );
  }

  const umaConfig = await response.json() as { registration_endpoint?: string };
  if (!umaConfig.registration_endpoint) {
    throw new Error(`UMA configuration at ${UMA_SERVER_URL} did not include registration_endpoint`);
  }

  return umaConfig.registration_endpoint;
}

async function registerClient(
  registrationEndpoint: string,
  patient: string,
  podUrl: string
): Promise<UmaRegistrationResponse> {
  const response = await fetch(registrationEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `WebID ${encodeURIComponent(podUrl)}`,
    },
    body: JSON.stringify({
      client_uri: podUrl,
      client_name: patient,
    }),
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }

  return response.json() as Promise<UmaRegistrationResponse>;
}

function toStoredCredentials(
  patient: string,
  podUrl: string,
  registration: UmaRegistrationResponse
): StoredClientCredentials {
  return {
    patient,
    podUrl,
    umaServerUrl: UMA_SERVER_URL,
    clientUri: registration.client_uri,
    clientName: registration.client_name ?? patient,
    clientId: registration.client_id,
    clientSecret: registration.client_secret,
    clientSecretExpiresAt: registration.client_secret_expires_at,
    grantTypes: registration.grant_types,
    tokenEndpointAuthMethod: registration.token_endpoint_auth_method,
    principalExtractor: PRINCIPAL_EXTRACTOR,
    extractorConfig: EXTRACTOR_CONFIG,
    allowedSkewSeconds: ALLOWED_SKEW_SECONDS,
    registeredAt: new Date().toISOString(),
  };
}

function toKvasirUmaConfig(credentials: StoredClientCredentials): KvasirUmaConfig {
  return {
    "server-url": UMA_SERVER_URL,
    "client-id": credentials.clientId,
    "client-secret": credentials.clientSecret,
    "principal-extractor": {
      "class-name": PRINCIPAL_EXTRACTOR,
      config: EXTRACTOR_CONFIG,
    },
    "jwt-allowed-clock-skew-seconds": ALLOWED_SKEW_SECONDS,
  };
}

async function getPatientAccessToken(credentials: UserCredentials): Promise<string> {
  const auth = new KeycloakOIDCAuth();
  await auth.init(config.idp, config.realm);
  await auth.login(credentials.username, credentials.password, config.clientId, config.clientSecret);
  return auth.getAccessToken();
}

async function fetchRuntimeConfig(
  podUrl: string,
  accessToken: string
): Promise<KvasirPodConfiguration> {
  const response = await fetch(`${podUrl}/runtime-config`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch Kvasir runtime config for ${podUrl}: ${response.status} ${await response.text()}`
    );
  }

  return response.json() as Promise<KvasirPodConfiguration>;
}

async function applyKvasirUmaSettings(
  podUrl: string,
  patientCredentials: UserCredentials,
  umaCredentials: StoredClientCredentials
): Promise<void> {
  const accessToken = await getPatientAccessToken(patientCredentials);
  const currentConfig = await fetchRuntimeConfig(podUrl, accessToken);
  const nextConfig: KvasirPodConfiguration = {
    ...currentConfig,
    auth: {
      ...(currentConfig.auth ?? {}),
      uma: toKvasirUmaConfig(umaCredentials),
    },
  };

  const response = await fetch(podUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "application/ld+json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      "@context": { kss: "https://kvasir.discover.ilabt.imec.be/vocab#" },
      "kss:configuration": JSON.stringify(nextConfig),
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to apply UMA settings to ${podUrl}: ${response.status} ${await response.text()}`
    );
  }
}

async function main() {
  const registrationEndpoint = await fetchRegistrationEndpoint();
  const output = await readCredentialsFile();
  const failures: Array<{ patient: string; error: unknown }> = [];
  const requestedPatients = process.env.KVASIR_PATIENTS
    ?.split(",")
    .map((patient) => patient.trim())
    .filter(Boolean);
  const requestedPatientSet = requestedPatients ? new Set(requestedPatients) : undefined;
  const allSources = requestedPatientSet
    ? kvasirPatientSources(DEFAULT_KVASIR_PATIENT_COUNT)
    : kvasirPatientSources();
  const sources = allSources.filter(({ client }) =>
    requestedPatientSet ? requestedPatientSet.has(client) : true
  );

  if (requestedPatientSet && sources.length !== requestedPatientSet.size) {
    const found = new Set(sources.map(({ client }) => client));
    const missing = [...requestedPatientSet].filter((patient) => !found.has(patient));
    throw new Error(`Unknown Kvasir patients requested: ${missing.join(", ")}`);
  }

  console.log(`=== Registering Kvasir patient pods with UMA ===`);
  console.log(`UMA server: ${UMA_SERVER_URL}`);
  console.log(`Registration endpoint: ${registrationEndpoint}`);
  console.log(`Output: ${OUTPUT_PATH}`);
  console.log(`Apply settings to Kvasir pods: ${APPLY_KVASIR_SETTINGS ? "yes" : "no"}`);
  if (requestedPatients) {
    console.log(`Patient filter: ${requestedPatients.join(", ")}`);
  }

  for (const { client, server } of sources) {
    const credentials = credentialsFor(client);
    const podUrl = `${withoutTrailingSlash(server)}/${credentials.username}`;

    console.log(`\n=== ${client} ===`);
    console.log(`Pod URL: ${podUrl}`);

    let storedCredentials = output.clients[client];

    try {
      const registration = await registerClient(registrationEndpoint, client, podUrl);
      storedCredentials = toStoredCredentials(client, podUrl, registration);
      output.clients[client] = storedCredentials;
      console.log(`Registered client id: ${registration.client_id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("409 ") && output.clients[client]?.clientSecret) {
        console.log(`Already registered; keeping existing local credentials.`);
        storedCredentials = output.clients[client];
      } else {
        failures.push({ patient: client, error });
        console.error(`Failed to register ${client}:`, error);
        continue;
      }
    }

    if (APPLY_KVASIR_SETTINGS && storedCredentials) {
      try {
        await applyKvasirUmaSettings(podUrl, credentials, storedCredentials);
        console.log(`Applied UMA settings to Kvasir pod.`);
      } catch (error) {
        failures.push({ patient: client, error });
        console.error(`Failed to apply UMA settings for ${client}:`, error);
      }
    }
  }

  await writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");

  console.log(`\n=== UMA settings ${APPLY_KVASIR_SETTINGS ? "applied" : "to apply"} in each Kvasir pod ===`);
  console.log(`Enable UMA server: true`);
  console.log(`Server URL: ${UMA_SERVER_URL}`);
  console.log(`Principal extractor: ${PRINCIPAL_EXTRACTOR}`);
  console.log(`Extractor config: ${JSON.stringify(EXTRACTOR_CONFIG)}`);
  console.log(`Allowed skew: ${ALLOWED_SKEW_SECONDS} seconds`);
  console.log(`Client ID / Client Secret: use each patient's entry in ${OUTPUT_PATH}`);

  const registeredOrKept = Object.keys(output.clients).length;
  console.log(
    `\n=== Finished: ${registeredOrKept} stored UMA client registrations, ${failures.length} failed ===`
  );

  if (failures.length > 0) {
    console.log(`Failed patients: ${failures.map(({ patient }) => patient).join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
