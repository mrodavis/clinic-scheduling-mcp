import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, setup } from "./helpers.ts";

test("protected resource metadata points clients at the authorization server", async () => {
  const { app } = await setup();
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const body = await (await app.request(`${BASE}${path}`)).json();
    assert.equal(body.resource, `${BASE}/mcp`);
    assert.deepEqual(body.authorization_servers, ["https://idp.test"]);
    assert.deepEqual(body.scopes_supported, ["clinic:read", "clinic:write"]);
  }
});

test("no token: 401 with a WWW-Authenticate challenge that names the metadata URL", async () => {
  const { app } = await setup();
  const res = await app.request(`${BASE}/mcp`, { method: "POST", body: "{}" });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("www-authenticate"), `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
});

test("tokens for another audience or issuer, expired tokens and clinicians without a provider are rejected", async () => {
  const { rest, token } = await setup();
  const cases = [
    await token("front_desk", { audience: "https://some-other-api.test" }),
    await token("front_desk", { issuer: "https://evil.test" }),
    await token("front_desk", { expiresIn: "-1m" }),
    await token("clinician"),
    await token("superuser"),
    "not-a-jwt",
  ];
  for (const t of cases) {
    const res = await rest(t, "/patients?query=ma");
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
  }
});

test("a valid token gets through", async () => {
  const { rest, token } = await setup();
  const res = await rest(await token("front_desk"), "/patients?query=maria");
  assert.equal(res.status, 200);
  const patients = await res.json();
  assert.deepEqual(
    patients.map((p: { name: string }) => p.name),
    ["Maria Santos", "Maria Santiago"],
  );
  assert.ok(patients.every((p: Record<string, unknown>) => !("phone" in p) && typeof p.phoneLast4 === "string"), "full phone numbers are not returned");
});
