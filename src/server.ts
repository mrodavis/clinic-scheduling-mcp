import { serve } from "@hono/node-server";
import { createRemoteJWKSet } from "jose";
import { createApp } from "./app.ts";
import { DEV_ISSUER, jwtVerifier, loadDevKeys } from "./auth.ts";
import { CLINIC } from "./domain/clinic.ts";
import { clinicNow } from "./domain/time.ts";
import { ClinicService } from "./service.ts";
import { ClinicStore, seedStore } from "./store.ts";

const port = Number(process.env.PORT ?? 3002);
const baseUrl = process.env.BASE_URL ?? `http://localhost:${port}`;
const issuer = process.env.OAUTH_ISSUER;
const jwksUrl = process.env.OAUTH_JWKS_URL;

const now = () => clinicNow(CLINIC.timeZone);
const store = seedStore(new ClinicStore(), now());
const service = new ClinicService(store, now);

const verifier =
  issuer && jwksUrl
    ? jwtVerifier({ keys: createRemoteJWKSet(new URL(jwksUrl)), issuer, audience: `${baseUrl}/mcp` })
    : jwtVerifier({ keys: (await loadDevKeys()).keys, issuer: DEV_ISSUER, audience: `${baseUrl}/mcp` });

const app = createApp({ service, verifier, baseUrl, authorizationServers: [issuer ?? DEV_ISSUER] });

serve({ fetch: app.fetch, port }, () => {
  console.log(`clinic-scheduling-mcp on ${baseUrl}  (MCP endpoint: ${baseUrl}/mcp)`);
  if (!issuer) console.log("DEV AUTH: tokens come from `npm run token -- --role front_desk`. Set OAUTH_ISSUER and OAUTH_JWKS_URL for a real identity provider.");
});
