import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalJWKSet, exportJWK, generateKeyPair, importJWK, jwtVerify, SignJWT, type JWK, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { ROLES, type Actor } from "./permissions.ts";

/** Claims we require from the identity provider's access token. */
const ClaimsSchema = z.object({
  sub: z.string().min(1),
  name: z.string().optional(),
  role: z.enum(ROLES),
  provider_id: z.string().optional(),
  scope: z.string().default(""),
  azp: z.string().optional(),
  client_id: z.string().optional(),
});

export class AuthError extends Error {}

export interface TokenVerifier {
  verify(token: string): Promise<Omit<Actor, "channel">>;
}

/**
 * Verifies an OAuth access token (JWT) against the authorization server's
 * signing keys. The audience must be THIS server's resource URL (RFC 8707),
 * so a token minted for another API is rejected even if the signature is good.
 */
export function jwtVerifier(opts: { keys: JWTVerifyGetKey; issuer: string; audience: string }): TokenVerifier {
  return {
    async verify(token) {
      let payload: unknown;
      try {
        ({ payload } = await jwtVerify(token, opts.keys, { issuer: opts.issuer, audience: opts.audience, algorithms: ["ES256", "RS256"] }));
      } catch (err) {
        throw new AuthError(err instanceof Error ? err.message : "invalid token");
      }
      const claims = ClaimsSchema.safeParse(payload);
      if (!claims.success) throw new AuthError("token is missing required claims");
      const c = claims.data;
      if (c.role === "clinician" && !c.provider_id) throw new AuthError("clinician token must carry provider_id");
      return {
        id: c.sub,
        name: c.name ?? c.sub,
        role: c.role,
        ...(c.provider_id ? { providerId: c.provider_id } : {}),
        scopes: c.scope.split(" ").filter(Boolean),
        clientId: c.azp ?? c.client_id ?? "unknown",
      };
    },
  };
}

/**
 * Local development only: a signing key kept in .dev/ (gitignored) so the
 * server and `npm run token` agree. In production, point OAUTH_ISSUER and
 * OAUTH_JWKS_URL at your identity provider instead.
 */
export const DEV_ISSUER = "https://dev-issuer.local";

export async function loadDevKeys(dir = ".dev") {
  const file = join(dir, "signing-key.json");
  if (!existsSync(file)) {
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ private: await exportJWK(privateKey), public: await exportJWK(publicKey) }), { mode: 0o600 });
  }
  const jwk = JSON.parse(readFileSync(file, "utf8")) as { private: JWK; public: JWK };
  const kid = "dev-1";
  return {
    privateKey: await importJWK(jwk.private, "ES256"),
    keys: createLocalJWKSet({ keys: [{ ...jwk.public, kid, alg: "ES256", use: "sig" }] }),
    kid,
  };
}

export async function signToken(
  key: CryptoKey | Uint8Array,
  claims: { sub: string; name?: string; role: string; provider_id?: string; scope: string; client_id?: string },
  opts: { issuer: string; audience: string; kid?: string; expiresIn?: string },
): Promise<string> {
  return new SignJWT({ ...claims, client_id: claims.client_id ?? "dev-cli" })
    .setProtectedHeader({ alg: "ES256", ...(opts.kid ? { kid: opts.kid } : {}) })
    .setIssuer(opts.issuer)
    .setAudience(opts.audience)
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? "1h")
    .sign(key);
}
