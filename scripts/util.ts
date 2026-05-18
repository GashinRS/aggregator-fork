const UMA_CONFIG_RETRIES = Number.parseInt(process.env.UMA_CONFIG_RETRIES ?? "5", 10);
const UMA_CONFIG_RETRY_DELAY_MS = Number.parseInt(process.env.UMA_CONFIG_RETRY_DELAY_MS ?? "1000", 10);
const TOKEN_REFRESH_BUFFER_MS = Number.parseInt(process.env.TOKEN_REFRESH_BUFFER_MS ?? "60000", 10);
const UMA_RPT_REFRESH_BUFFER_MS = Number.parseInt(process.env.UMA_RPT_REFRESH_BUFFER_MS ?? "30000", 10);
const UMA_CONFIG_CACHE = new Map<string, any>();
const UMA_RPT_CACHE = new Map<string, { accessToken: string; tokenType: string; expiresAt: number }>();

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isTransientUMAConfigFailure(status: number) {
    return status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export async function getUMAConfig(as_uri: string) {
    const cached = UMA_CONFIG_CACHE.get(as_uri);
    if (cached) return cached;

    const config_uri = `${as_uri}/.well-known/uma2-configuration`;

    let lastError: unknown;
    for (let attempt = 1; attempt <= UMA_CONFIG_RETRIES; attempt++) {
        try {
            const response = await fetch(config_uri, {
                method: "GET",
                headers: { "Accept": "application/json" }
            });

            if (response.ok) {
                const config = await response.json();
                UMA_CONFIG_CACHE.set(as_uri, config);
                return config;
            }

            const responseBody = await response.text();
            lastError = new Error(`Failed to fetch UMA config: ${response.status} ${response.statusText}${responseBody ? `, response: ${responseBody}` : ""}`);

            if (!isTransientUMAConfigFailure(response.status) || attempt === UMA_CONFIG_RETRIES) {
                throw lastError;
            }
        } catch (err) {
            lastError = err;
            if (attempt === UMA_CONFIG_RETRIES) {
                throw err;
            }
        }

        const delay = UMA_CONFIG_RETRY_DELAY_MS * attempt;
        console.warn(`Failed to fetch UMA config from ${config_uri}; retrying in ${delay}ms (attempt ${attempt}/${UMA_CONFIG_RETRIES})`);
        await sleep(delay);
    }

    throw lastError instanceof Error ? lastError : new Error(`Failed to fetch UMA config: ${String(lastError)}`);
}

async function parseAuthenticateHeader(wwwAuthenticateHeader: string): Promise<{ issuer: string, tokenEndpoint: string; ticket: string }> {
    const paramsPart = wwwAuthenticateHeader.replace(/^\w+\s+/, '');

    const params = Object.fromEntries(
    paramsPart.split(',').map(param => {
        const [key, value] = param.split('=');
        return [key.trim(), value.replace(/"/g, '').trim()];
    })
    );

    const { as_uri, ticket } = params;

    const config = await getUMAConfig(as_uri);
    // const serviceEndpoint = headers.get("Link")?.match(/<([^>]+)>;\s*rel="service-token-endpoint"/)?.[1];

    return {
        issuer: as_uri,
        tokenEndpoint: config.token_endpoint,
        ticket
    }
}

export class KeycloakOIDCAuth {
    private tokenEndpoint!: string;

    public accessToken: string | undefined;
    private idToken: string | undefined;
    private expiresAt: number | undefined;

    private username!: string;
    private password!: string;
    private clientId!: string;
    private clientSecret!: string;

    async init(idpHost: string, realm: string) {
        const configEndpoint = `${idpHost}/realms/${realm}/.well-known/openid-configuration`

        const response = await fetch(configEndpoint, {
            method: "GET",
            headers: { "content-type": "application/json" }
        });

        if (!response.ok) {
            throw new Error(`Error fetching keycloak config: ${response.status} ${response.statusText} ${await response.text()}`);
        }

        const data = await response.json();

        this.tokenEndpoint = data.token_endpoint;
    }

    /**
     * Initialize Keycloak OIDC authentication
     */
    async login(username: string, password: string, client_id: string, client_secret: string) {
        this.username = username;
        this.password = password;
        this.clientId = client_id;
        this.clientSecret = client_secret;

        await this.refreshAccessToken();
    }

    private async directAccessTokenRequest(): Promise<any> {
        const params = new URLSearchParams({
            grant_type: 'password',
            username: this.username,
            password: this.password,
            client_id: this.clientId,
            client_secret: this.clientSecret,
            scope: "openid offline_access",
        });

        const response = await fetch(this.tokenEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: params.toString()
        });

        if (!response.ok) {
            throw new Error(`Keycloak login failed: ${response.status} ${await response.text()}`);
        }

        const data = await response.json();

        return data;
    }

    /**
     * Refresh access token
     */
    public async refreshAccessToken(): Promise<void> {
        const tokenResponse = await this.directAccessTokenRequest();
        this.accessToken = tokenResponse.access_token;
        this.idToken = tokenResponse.id_token;
        this.expiresAt = Date.now() + (tokenResponse.expires_in * 1000);
    }

    /**
     * Make sure access token is still valid, otherwise refresh it.
     */
    private async ensureValidTokens() {
        if (!this.accessToken || !this.expiresAt || Date.now() >= this.expiresAt - TOKEN_REFRESH_BUFFER_MS) {
            await this.refreshAccessToken();
        }
    }

    /**
     * Create the claim token used for UMA
     * (For Keycloak this is simply the OIDC access token)
     */
    public async getAccessToken(): Promise<string> {
        await this.ensureValidTokens();

        if (!this.accessToken || !this.idToken) throw new Error("Not initialized");

        return this.accessToken;
    }

    public async getIdToken() {
        await this.ensureValidTokens();

        if (!this.accessToken || !this.idToken) throw new Error("Not initialized");

        return this.idToken;
    }

    /**
     * Create the UMA fetch behavior
     */
    createUMAFetch() {
        return async (url: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
            const cacheKey = umaRptCacheKey(url, init);
            const cached = UMA_RPT_CACHE.get(cacheKey);
            if (cached && cached.expiresAt > Date.now() + UMA_RPT_REFRESH_BUFFER_MS) {
                const cachedHeaders = new Headers(init.headers);
                cachedHeaders.set("Authorization", `${cached.tokenType} ${cached.accessToken}`);

                const cachedResponse = await fetch(url, { ...init, headers: cachedHeaders });
                if (cachedResponse.status >= 200 && cachedResponse.status < 300) {
                    return cachedResponse;
                }

                if (shouldRetryWithoutCachedRpt(cachedResponse)) {
                    UMA_RPT_CACHE.delete(cacheKey);
                } else {
                    return cachedResponse;
                }
            }

            // First attempt with no token
            const noTokenResponse = await fetch(url, init);

            if (noTokenResponse.status >= 200 && noTokenResponse.status < 300) {
                console.log("No Authorization token was required.");
                return noTokenResponse;
            }

            // Parse the UMA authenticate header
            const wwwAuthenticateHeader = noTokenResponse.headers.get("WWW-Authenticate");
            if (!wwwAuthenticateHeader) {
                console.log("No WWW-Authenticate header was provided.");
                return noTokenResponse;
            }
            const { issuer, tokenEndpoint, ticket } = await parseAuthenticateHeader(wwwAuthenticateHeader);

            // Create Keycloak OIDC ID token as claim
            const claimToken = await this.getIdToken();
            
            // UMA token exchange request
            const umaRequestBody = new URLSearchParams({
                grant_type: "urn:ietf:params:oauth:grant-type:uma-ticket",
                ticket,
                claim_token: claimToken,
                claim_token_format: "http://openid.net/specs/openid-connect-core-1_0.html#IDToken"
            });

            const umaResponse = await fetch(tokenEndpoint, {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded" },
                body: umaRequestBody.toString()
            });

            if (!umaResponse.ok) {
                return umaResponse; // propagate error
            }

            const rptJson = await umaResponse.json();
            cacheUmaRpt(cacheKey, rptJson);

            // Add RPT to headers
            const newHeaders = new Headers(init.headers);
            newHeaders.set("Authorization", `${rptJson.token_type} ${rptJson.access_token}`);

            // Retry the original request
            return fetch(url, { ...init, headers: newHeaders });
        };
    }
}

function umaRptCacheKey(url: RequestInfo | URL, init: RequestInit): string {
    const method = (init.method ?? "GET").toUpperCase();
    const urlString =
        typeof url === "string" ? url :
        url instanceof URL ? url.toString() :
        url.url;

    return `${method} ${urlString}`;
}

function shouldRetryWithoutCachedRpt(response: Response): boolean {
    return response.headers.has("WWW-Authenticate") ||
        response.status === 400 ||
        response.status === 401 ||
        response.status === 403;
}

function cacheUmaRpt(cacheKey: string, rptJson: any) {
    if (typeof rptJson?.access_token !== "string" || rptJson.access_token.length === 0) {
        return;
    }

    UMA_RPT_CACHE.set(cacheKey, {
        accessToken: rptJson.access_token,
        tokenType: typeof rptJson.token_type === "string" && rptJson.token_type.length > 0 ? rptJson.token_type : "Bearer",
        expiresAt: jwtExpiresAt(rptJson.access_token) ?? Date.now() + 4 * 60_000,
    });
}

function jwtExpiresAt(token: string): number | undefined {
    const [, payload] = token.split(".");
    if (!payload) {
        return undefined;
    }

    try {
        const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        return typeof parsed.exp === "number" ? parsed.exp * 1000 : undefined;
    } catch {
        return undefined;
    }
}
