import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { createApp } from "../src/app.ts";
import { jwtVerifier, signToken } from "../src/auth.ts";
import { ClinicService } from "../src/service.ts";
import { ClinicStore } from "../src/store.ts";

/** Monday 2026-11-16, 8:00 clinic time. */
export const NOW = "2026-11-16T08:00";
export const BASE = "http://clinic.test";
export const ISSUER = "https://idp.test";
export const AUDIENCE = `${BASE}/mcp`;

const openClients: Client[] = [];

/** Call from an after() hook so open MCP connections do not keep the test process alive. */
export async function closeClients() {
  await Promise.all(openClients.splice(0).map((c) => c.close()));
}

export async function setup() {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "test", alg: "ES256" }] });
  const store = new ClinicStore(undefined);
  const service = new ClinicService(store, () => NOW);
  const app = createApp({ service, verifier: jwtVerifier({ keys, issuer: ISSUER, audience: AUDIENCE }), baseUrl: BASE, authorizationServers: [ISSUER] });

  const token = (
    role: string,
    opts: { scope?: string; providerId?: string; sub?: string; audience?: string; issuer?: string; expiresIn?: string } = {},
  ) =>
    signToken(
      privateKey,
      {
        sub: opts.sub ?? `user-${role}`,
        role,
        scope: opts.scope ?? "clinic:read clinic:write",
        ...(opts.providerId ? { provider_id: opts.providerId } : {}),
      },
      { issuer: opts.issuer ?? ISSUER, audience: opts.audience ?? AUDIENCE, kid: "test", ...(opts.expiresIn ? { expiresIn: opts.expiresIn } : {}) },
    );

  /** A real MCP client speaking Streamable HTTP to the app in-process. */
  const mcp = async (bearer: string) => {
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      fetch: async (url, init) => app.request(url.toString(), init),
      requestInit: { headers: { authorization: `Bearer ${bearer}` } },
    });
    await client.connect(transport);
    openClients.push(client);
    return client;
  };

  const rest = (bearer: string, path: string, init: { method?: string; body?: unknown } = {}) =>
    app.request(`${BASE}/api${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });

  return { app, store, service, token, mcp, rest };
}

export function text(result: unknown): string {
  const r = result as { content: Array<{ type: string; text?: string }> };
  return r.content.map((c) => c.text ?? "").join("");
}

export function json<T = any>(result: unknown): T {
  return JSON.parse(text(result)) as T;
}
