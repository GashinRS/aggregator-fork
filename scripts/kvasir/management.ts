import { KeycloakOIDCAuth } from "../util.js";

type KvasirValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: KvasirValue };

type KvasirInsert = Record<string, KvasirValue>;

export class KvasirManagement {

  private podUrl: string;
  private umaUrl: string;

  public auth: KeycloakOIDCAuth;
  private umaFetch: (url: string, init?: RequestInit) => Promise<Response> = async () => {
    throw new Error("UMA fetch called before login");
  };

  constructor(podUrl: string, umaUrl: string) {
    this.podUrl = podUrl;
    this.umaUrl = umaUrl;

    this.auth = new KeycloakOIDCAuth();
  }

  public async init(idp: string, realm: string) {
    await this.auth.init(idp, realm);
  }

  public async login(username: string, password: string, clientId: string, clientSecret: string) {
    await this.auth.login(username, password, clientId, clientSecret);
    this.umaFetch = this.auth.createUMAFetch();
  }

  public async delegatePodToUMA() {
    const relationsUri = this.podUrl + "/rebac/relationships";
    console.log("POD URL: ", this.podUrl)
    try {
      const resp = await fetch(relationsUri, {
        method: "POST",
        headers: {
          "Content-Type": "application/ld+json",
          "Authorization": `Bearer ${await this.auth.getAccessToken()}`
        },
        body: JSON.stringify({
          "@context": {
            "kss": "https://kvasir.discover.ilabt.imec.be/vocab#",
            "kss-fga": "https://kvasir.discover.ilabt.imec.be/fine-grained-access#"
          },
          "kss:insert": [
            {
              "@id": "urn:kvasir-wildcard",
              "@type": "kss-fga:User",
              "kss-fga:owner": {
                "@id": this.podUrl,
                "@type": "kss-fga:Resource",
                "kss-fga:external_access": {
                  "@id": "kss-fga:Uma"
                }
              }
            }
          ]
        })
      });

      if (!resp.ok) {
        console.error(`Error ${resp.status}:`, await resp.text());
        return;
      }
      
      console.log(`Response ${resp.status}:, ${await resp.text()}`);
    } catch(err) {
      console.error("Request failed:", err);
    }
  }

  /**
   * Ensure the pod-wide UMA delegation tuple exists without attempting to
   * insert it again on every setup run.
   */
  public async ensurePodDelegatedToUMA(): Promise<"created" | "unchanged"> {
    const relationsUri = `${this.podUrl}/rebac/relationships`;
    const visitedPages = new Set<string>();
    let nextPage: string | undefined = `${relationsUri}?pageSize=100`;

    // Kvasir/OpenFGA bounds relationship page sizes. Follow its standard
    // rel="next" cursor links instead of requesting one oversized page.
    while (nextPage) {
      if (visitedPages.has(nextPage)) {
        throw new Error(`Kvasir returned a repeated relationships page: ${nextPage}`);
      }
      visitedPages.add(nextPage);

      const readResponse = await fetch(nextPage, {
        method: "GET",
        headers: {
          "Accept": "application/ld+json",
          "Authorization": `Bearer ${await this.auth.getAccessToken()}`,
        },
      });

      if (!readResponse.ok) {
        throw new Error(
          `Could not read Kvasir relationships for ${this.podUrl}: ${readResponse.status} ${await readResponse.text()}`
        );
      }

      const relationships = await readResponse.json() as unknown;
      if (this.containsUmaDelegation(relationships)) {
        return "unchanged";
      }

      nextPage = this.nextLink(readResponse.headers.get("link"), relationsUri);
    }

    const createResponse = await fetch(relationsUri, {
      method: "POST",
      headers: {
        "Content-Type": "application/ld+json",
        "Authorization": `Bearer ${await this.auth.getAccessToken()}`,
      },
      body: JSON.stringify({
        "@context": {
          "kss": "https://kvasir.discover.ilabt.imec.be/vocab#",
          "kss-fga": "https://kvasir.discover.ilabt.imec.be/fine-grained-access#",
        },
        "kss:insert": [
          {
            "@id": "urn:kvasir-wildcard",
            "@type": "kss-fga:User",
            "kss-fga:owner": {
              "@id": this.podUrl,
              "@type": "kss-fga:Resource",
              "kss-fga:external_access": {
                "@id": "kss-fga:Uma",
              },
            },
          },
        ],
      }),
    });

    if (!createResponse.ok) {
      throw new Error(
        `Could not delegate ${this.podUrl} to UMA: ${createResponse.status} ${await createResponse.text()}`
      );
    }

    return "created";
  }

  private nextLink(linkHeader: string | null, baseUrl: string): string | undefined {
    if (!linkHeader) {
      return undefined;
    }

    for (const link of linkHeader.split(",")) {
      const target = link.match(/^\s*<([^>]+)>/);
      if (target?.[1] && /;\s*rel\s*=\s*"?next"?/i.test(link)) {
        return new URL(target[1], baseUrl).toString();
      }
    }

    return undefined;
  }

  private containsUmaDelegation(value: unknown): boolean {
    if (Array.isArray(value)) {
      return value.some((entry) => this.containsUmaDelegation(entry));
    }

    if (value === null || typeof value !== "object") {
      return false;
    }

    const node = value as Record<string, unknown>;
    if (node["@id"] === "urn:kvasir-wildcard") {
      const owner = this.valuesForRelation(node, "owner");
      if (owner.some((entry) => this.isUmaDelegatedPod(entry))) {
        return true;
      }
    }

    return Object.values(node).some((entry) => this.containsUmaDelegation(entry));
  }

  private isUmaDelegatedPod(value: unknown): boolean {
    if (Array.isArray(value)) {
      return value.some((entry) => this.isUmaDelegatedPod(entry));
    }

    if (value === null || typeof value !== "object") {
      return false;
    }

    const node = value as Record<string, unknown>;
    if (node["@id"] !== this.podUrl) {
      return false;
    }

    return this.valuesForRelation(node, "external_access").some((entry) => {
      if (entry === null || typeof entry !== "object") {
        return false;
      }

      const id = (entry as Record<string, unknown>)["@id"];
      return typeof id === "string" && /(?:#|:)uma$/i.test(id);
    });
  }

  private valuesForRelation(node: Record<string, unknown>, relation: string): unknown[] {
    const matchingValue = Object.entries(node).find(([key]) =>
      key === `kss-fga:${relation}` || key.endsWith(`#${relation}`)
    )?.[1];

    if (matchingValue === undefined) {
      return [];
    }

    return Array.isArray(matchingValue) ? matchingValue : [matchingValue];
  }

  public async registerPolicies(turtle: string) {
    const policyUri = `${this.umaUrl}/policies`;

    try {
      const resp = await fetch(policyUri, {
        method: "POST",
        headers: {
          "Content-Type": "text/turtle",
          "Authorization": `Bearer ${await this.auth.getIdToken()}`,
        },
        body: turtle,
      });

      if (!resp.ok) {
        console.error(`Error ${resp.status}:`, await resp.text());
        return;
      }

      console.log(`Response ${resp.status}:, ${await resp.text()}`);
    } catch (err) {
      console.error("Request failed:", err);
    }
  }

  /**
   * Create a policy with a stable ID, or completely replace the existing
   * policy with that ID. This makes setup scripts safe to run repeatedly.
   */
  public async upsertPolicy(policyId: string, turtle: string): Promise<"created" | "updated"> {
    const policyContainerUri = `${this.umaUrl}/policies`;
    const policyUri = `${policyContainerUri}/${encodeURIComponent(policyId)}`;
    const readResponse = await fetch(policyUri, {
      method: "GET",
      headers: {
        "Accept": "text/turtle",
        "Authorization": `Bearer ${await this.auth.getAccessToken()}`,
      },
    });

    if (readResponse.ok) {
      const updateResponse = await fetch(policyUri, {
        method: "PUT",
        headers: {
          "Content-Type": "text/turtle",
          "Authorization": `Bearer ${await this.auth.getIdToken()}`,
        },
        body: turtle,
      });

      if (!updateResponse.ok) {
        throw new Error(
          `Could not update UMA policy ${policyId}: ${updateResponse.status} ${await updateResponse.text()}`
        );
      }

      return "updated";
    }

    if (readResponse.status !== 404) {
      throw new Error(
        `Could not check UMA policy ${policyId}: ${readResponse.status} ${await readResponse.text()}`
      );
    }

    const createResponse = await fetch(policyContainerUri, {
      method: "POST",
      headers: {
        "Content-Type": "text/turtle",
        "Authorization": `Bearer ${await this.auth.getIdToken()}`,
      },
      body: turtle,
    });

    if (createResponse.ok) {
      return "created";
    }

    // If another setup process created the deterministic policy between our
    // GET and POST, converge by replacing it instead of failing on conflict.
    if (createResponse.status === 409) {
      const updateResponse = await fetch(policyUri, {
        method: "PUT",
        headers: {
          "Content-Type": "text/turtle",
          "Authorization": `Bearer ${await this.auth.getIdToken()}`,
        },
        body: turtle,
      });

      if (updateResponse.ok) {
        return "updated";
      }

      throw new Error(
        `Could not update concurrently-created UMA policy ${policyId}: ${updateResponse.status} ${await updateResponse.text()}`
      );
    }

    throw new Error(
      `Could not create UMA policy ${policyId}: ${createResponse.status} ${await createResponse.text()}`
    );
  }

  public async readPolicies(assigner: string) {
    const policyUri = `${this.umaUrl}/policies`;

    try {
      const resp = await fetch(policyUri, {
        method: "GET",
        headers: {
          "Content-Type": "text/turtle",
          "Authorization": `Bearer ${await this.auth.getAccessToken()}`,
        },
      });

      if (!resp.ok) {
        console.error(`Error ${resp.status}:`, await resp.text());
        return;
      }

      console.log(`Response ${resp.status}:, ${await resp.text()}`);
    } catch (err) {
      console.error("Request failed:", err);
    }
  }

  public async deletePolicies(policyIds: string[]) {
    async function deletePolicy(idToken: string, policyId: string, umaUrl: string) {
      const policyUri = `${umaUrl}/policies/${encodeURIComponent(policyId)}`;
      try {
        const resp = await fetch(policyUri, {
          method: "DELETE",
          headers: {
            "Content-Type": "text/turtle",
            "Authorization": `Bearer ${idToken}`,
          },
        });

        if (!resp.ok) {
          console.error(`Error ${resp.status}:`, await resp.text());
          return;
        }

        console.log("Deleted:", policyId, await resp.text());
      } catch (err) {
        console.error("Request failed:", err);
      }
    }

    for (const id of policyIds) {
      await deletePolicy(await this.auth.getIdToken(), id, this.umaUrl);
    }
  }

  public async registerSlice(
    context: any, 
    schema: string, 
    sliceName: string,
    sliceDescription: string,
  ): Promise<string> {
    const sliceUri = `${this.podUrl}/slices`;

    const body = {
      "@context": context,
      "kss:name": sliceName,
      "kss:description": sliceDescription,
      "kss:schema": {
        "@type": "kss:EmbeddedSliceSchema",
        "kss:sdl": schema,
      },
      "kss:tags": [],
    };

    const resp = await this.umaFetch(sliceUri, {
      method: "POST",
      headers: {
        "Content-Type": "application/ld+json",
      },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      if (resp.status === 409) {
        console.log("Slice already exists");
        return `${sliceUri}/${sliceName}`;
      }
      const errorText = await resp.text();
      throw new Error(`Error Regestering slice ${resp.status}: ${errorText}`);
    }

    console.log(`Slice registered ${resp.status}`);
    return `${sliceUri}/${sliceName}`;
  }

  public async deleteSlice(slice: string) {
    try {
      const resp = await this.umaFetch(slice, {
        method: "DELETE",
      });

      if (!resp.ok) {
        const errorText = await resp.text();
        console.error(`Error ${resp.status}: ${errorText}`);
        return;
      }

      console.log(`Slice deleted`);
    } catch (err) {
      console.error("Request failed:", err);
    }
  }

  public async addData(
    slice: string,
    context: any,
    data: KvasirInsert[]
  ) {
    const transformRecord = (record: KvasirInsert): any => {
      const transformObject = (obj: KvasirInsert): any => {
        const result: Record<string, any> = {};

        for (const [key, value] of Object.entries(obj)) {
          // handle id -> @id at top level
          if (key === "id") {
            result["@id"] = value;
            continue;
          }

          // preserve JSON-LD keywords
          if (key.startsWith("@")) {
            result[key] = value;
            continue;
          }

          // replace first "_" with ":"
          const newKey = key.replace("_", ":");

          if (value !== null && typeof value === "object" && !Array.isArray(value)) {
            result[newKey] = transformObject(value as KvasirInsert);
          } else {
            result[newKey] = value;
          }
        }

        return result;
      };

      const transformed = transformObject(record);

      return transformed;
    };

    const body = {
      "@context": context,
      "kss:insert": data.map(transformRecord),
    };

    console.log("Adding data: ", JSON.stringify(body, null, 2))

    const resp = await this.umaFetch(`${slice}/changes`, {
      method: "POST",
      headers: { "Content-Type": "application/ld+json" },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      throw new Error(`${resp.status} ${resp.statusText}: ${await resp.text()}`);
    }
  }
}
