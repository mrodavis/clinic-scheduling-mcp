/**
 * Mints a short-lived development token signed with the local dev key.
 *   npm run token -- --role front_desk
 *   npm run token -- --role clinician --provider prv_okafor
 *   npm run token -- --role admin --scope clinic:read
 */
import { parseArgs } from "node:util";
import { DEV_ISSUER, loadDevKeys, signToken } from "../src/auth.ts";

const { values } = parseArgs({
  options: {
    role: { type: "string", default: "front_desk" },
    provider: { type: "string" },
    scope: { type: "string", default: "clinic:read clinic:write" },
    sub: { type: "string" },
  },
});

const port = Number(process.env.PORT ?? 3002);
const audience = `${process.env.BASE_URL ?? `http://localhost:${port}`}/mcp`;
const { privateKey, kid } = await loadDevKeys();
const role = values.role!;
const token = await signToken(
  privateKey,
  {
    sub: values.sub ?? `dev-${role}`,
    name: `Dev ${role}`,
    role,
    scope: values.scope!,
    ...(values.provider ? { provider_id: values.provider } : role === "clinician" ? { provider_id: "prv_okafor" } : {}),
  },
  { issuer: DEV_ISSUER, audience, kid, expiresIn: "8h" },
);
console.log(token);
