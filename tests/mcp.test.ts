import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeClients, json, setup, text } from "./helpers.ts";

after(closeClients);

const BOOK = { patientId: "pt_1001", providerId: "prv_okafor", visitType: "follow_up", start: "2026-11-16T09:00", reason: "Recheck after antibiotics" };

async function toolNames(client: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["mcp"]>>) {
  return (await client.listTools()).tools.map((t) => t.name).sort();
}

test("tools/list shows each caller only the tools their role AND token scope allow", async () => {
  const { mcp, token } = await setup();
  const read = ["find_available_slots", "get_appointment", "get_provider_schedule", "list_patient_appointments", "search_patients"];
  assert.deepEqual(await toolNames(await mcp(await token("front_desk"))), [...read, "book_appointment", "cancel_appointment", "reschedule_appointment"].sort());
  assert.deepEqual(await toolNames(await mcp(await token("clinician", { providerId: "prv_okafor" }))), [...read, "add_previsit_note"].sort());
  assert.deepEqual(await toolNames(await mcp(await token("admin"))), [...read, "book_appointment", "cancel_appointment", "get_audit_log", "reschedule_appointment"].sort());
  assert.deepEqual(await toolNames(await mcp(await token("front_desk", { scope: "clinic:read" }))), read, "read-only token, read-only tools");
});

test("tool annotations tell the client which calls change data", async () => {
  const { mcp, token } = await setup();
  const tools = (await (await mcp(await token("front_desk"))).listTools()).tools;
  const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
  assert.equal(byName.search_patients?.readOnlyHint, true);
  assert.equal(byName.cancel_appointment?.destructiveHint, true);
  assert.equal(byName.book_appointment?.idempotentHint, true);
});

test("a booking made over MCP is visible over REST, and both channels land in one audit log", async () => {
  const { mcp, rest, token, store } = await setup();
  const desk = await token("front_desk", { sub: "desk-ana" });
  const booked = json(await (await mcp(desk)).callTool({ name: "book_appointment", arguments: BOOK }));
  assert.equal(booked.status, "booked");
  assert.equal(booked.end, "2026-11-16T09:20");

  const viaRest = await (await rest(desk, `/appointments/${booked.id}`)).json();
  assert.equal(viaRest.patient.name, "Maria Santos");

  const mine = store.audit.filter((e) => e.actorId === "desk-ana").map((e) => `${e.channel}:${e.action}:${e.outcome}`);
  assert.deepEqual(mine, ["mcp:appointment.book:allowed", "rest:appointment.view:allowed"]);
});

test("double booking and rule violations come back as readable tool errors", async () => {
  const { mcp, token } = await setup();
  const client = await mcp(await token("front_desk"));
  await client.callTool({ name: "book_appointment", arguments: BOOK });

  const again = await client.callTool({ name: "book_appointment", arguments: { ...BOOK, patientId: "pt_1003" } });
  assert.equal(again.isError, true);
  assert.equal(text(again), "conflict: slot_taken");

  const peds = await client.callTool({ name: "book_appointment", arguments: { ...BOOK, providerId: "prv_herrera", start: "2026-11-16T10:00" } });
  assert.equal(text(peds), "conflict: patient_age_out_of_range");
});

test("a retried booking with the same idempotency key does not double book", async () => {
  const { mcp, token, store } = await setup();
  const client = await mcp(await token("front_desk"));
  const args = { ...BOOK, idempotencyKey: "call-7f3a-attempt" };
  const first = json(await client.callTool({ name: "book_appointment", arguments: args }));
  const retry = json(await client.callTool({ name: "book_appointment", arguments: args }));
  assert.equal(retry.id, first.id);
  assert.equal(store.appointments.length, 1);

  const reused = await client.callTool({ name: "book_appointment", arguments: { ...args, start: "2026-11-16T09:20" } });
  assert.equal(text(reused), "conflict: idempotency_key_reused");
});

test("pre-visit notes: only the clinician whose appointment it is can write or read them", async () => {
  const { mcp, rest, token, store } = await setup();
  const desk = await token("front_desk");
  const { id } = json(await (await mcp(desk)).callTool({ name: "book_appointment", arguments: BOOK }));

  const okafor = await mcp(await token("clinician", { providerId: "prv_okafor", sub: "dr-okafor" }));
  const written = json(await okafor.callTool({ name: "add_previsit_note", arguments: { appointmentId: id, note: "Review culture results." } }));
  assert.equal(written.previsitNote, "Review culture results.");

  const chen = await mcp(await token("clinician", { providerId: "prv_chen", sub: "np-chen" }));
  const denied = await chen.callTool({ name: "add_previsit_note", arguments: { appointmentId: id, note: "x" } });
  assert.match(text(denied), /^forbidden/);
  assert.equal(json(await chen.callTool({ name: "get_appointment", arguments: { appointmentId: id } })).previsitNote, undefined);

  const asDesk = await (await rest(desk, `/appointments/${id}`)).json();
  const asAdmin = await (await rest(await token("admin"), `/appointments/${id}`)).json();
  assert.equal("previsitNote" in asDesk, false);
  assert.equal("previsitNote" in asAdmin, false, "admins run operations; they do not need clinical notes");

  const denial = store.audit.find((e) => e.actorId === "np-chen" && e.outcome === "denied");
  assert.equal(denial?.code, "not_own_patient");
});

test("the service enforces permissions even if a tool is called directly", async () => {
  const { mcp, rest, token, store } = await setup();
  const readOnly = await token("front_desk", { scope: "clinic:read", sub: "desk-readonly" });

  // Over MCP the tool does not exist for this caller.
  const viaMcp = await (await mcp(readOnly)).callTool({ name: "book_appointment", arguments: BOOK });
  assert.equal(viaMcp.isError, true);

  // Over REST the endpoint exists, and the service says no, and records it.
  const viaRest = await rest(readOnly, "/appointments", { method: "POST", body: BOOK });
  assert.equal(viaRest.status, 403);
  assert.equal(store.appointments.length, 0);
  assert.deepEqual(
    store.audit.filter((e) => e.actorId === "desk-readonly").map((e) => [e.action, e.outcome, e.code]),
    [["appointment.book", "denied", "role_or_scope"]],
  );
});

test("reschedule and late cancel", async () => {
  const { mcp, token } = await setup();
  const client = await mcp(await token("front_desk"));
  const { id } = json(await client.callTool({ name: "book_appointment", arguments: BOOK }));

  const moved = json(await client.callTool({ name: "reschedule_appointment", arguments: { appointmentId: id, newStart: "2026-11-16T09:20" } }));
  assert.equal(moved.start, "2026-11-16T09:20");

  const cancelled = json(await client.callTool({ name: "cancel_appointment", arguments: { appointmentId: id, reason: "Feeling better" } }));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.lateCancel, true, "same-day cancellation is late");

  const twice = await client.callTool({ name: "cancel_appointment", arguments: { appointmentId: id, reason: "again" } });
  assert.equal(text(twice), "conflict: already_cancelled");
});

test("the audit log holds IDs, never names, reasons or notes", async () => {
  const { mcp, rest, token, store } = await setup();
  const { id } = json(await (await mcp(await token("front_desk"))).callTool({ name: "book_appointment", arguments: BOOK }));
  await (await mcp(await token("clinician", { providerId: "prv_okafor" }))).callTool({ name: "add_previsit_note", arguments: { appointmentId: id, note: "Sensitive clinical detail" } });
  await rest(await token("front_desk"), "/patients?query=maria");

  const serialized = JSON.stringify(store.audit);
  for (const secret of ["Maria", "Santos", "antibiotics", "Sensitive clinical detail", "maria"]) assert.ok(!serialized.includes(secret), secret);

  const audit = json(await (await mcp(await token("admin"))).callTool({ name: "get_audit_log", arguments: { limit: 10 } }));
  assert.ok(audit.length >= 3);
});
