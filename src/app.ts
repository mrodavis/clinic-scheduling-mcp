import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { VISIT_TYPE_IDS } from "./domain/clinic.ts";
import { LOCAL_DATE, LOCAL_DATETIME } from "./domain/time.ts";
import { AuthError, type TokenVerifier } from "./auth.ts";
import { buildMcpServer } from "./mcp.ts";
import type { Actor } from "./permissions.ts";
import { ConflictError, ForbiddenError, NotFoundError, type ClinicService } from "./service.ts";

export interface AppConfig {
  service: ClinicService;
  verifier: TokenVerifier;
  /** Public base URL of this server, e.g. https://clinic-mcp.example.com */
  baseUrl: string;
  authorizationServers: string[];
}

type Env = { Variables: { actor: Omit<Actor, "channel">; token: string } };

const BookSchema = z.object({
  patientId: z.string(),
  providerId: z.string(),
  visitType: z.enum(VISIT_TYPE_IDS),
  start: z.string().regex(LOCAL_DATETIME),
  reason: z.string().min(1).max(300),
  idempotencyKey: z.string().min(8).max(100).optional(),
});

export function createApp(cfg: AppConfig) {
  const { service } = cfg;
  const resource = `${cfg.baseUrl}/mcp`;
  const metadataUrl = `${cfg.baseUrl}/.well-known/oauth-protected-resource/mcp`;
  const app = new Hono<Env>();

  app.get("/health", (c) => c.json({ ok: true }));

  // RFC 9728: tells an MCP client which authorization server issues tokens for this resource.
  const metadata = (c: Context) =>
    c.json({
      resource,
      authorization_servers: cfg.authorizationServers,
      scopes_supported: ["clinic:read", "clinic:write"],
      bearer_methods_supported: ["header"],
      resource_name: "Clinic scheduling (synthetic demo)",
    });
  app.get("/.well-known/oauth-protected-resource", metadata);
  app.get("/.well-known/oauth-protected-resource/mcp", metadata);

  const requireAuth = async (c: Context<Env>, next: () => Promise<void>) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const challenge = (error?: string) =>
      `Bearer resource_metadata="${metadataUrl}"${error ? `, error="${error}"` : ""}`;
    if (!token) {
      c.header("WWW-Authenticate", challenge());
      return c.json({ error: "unauthorized" }, 401);
    }
    try {
      c.set("actor", await cfg.verifier.verify(token));
      c.set("token", token);
    } catch (err) {
      if (!(err instanceof AuthError)) throw err;
      c.header("WWW-Authenticate", challenge("invalid_token"));
      return c.json({ error: "invalid_token", detail: err.message }, 401);
    }
    await next();
  };

  // MCP over Streamable HTTP, stateless: a fresh server per request, built for this caller.
  // Stateless servers have nothing to push, so the optional GET event stream and DELETE session end are not offered.
  app.on(["GET", "DELETE"], "/mcp", (c) => {
    c.header("Allow", "POST");
    return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this server is stateless, use POST" }, id: null }, 405);
  });
  app.post("/mcp", requireAuth, async (c) => {
    const actor: Actor = { ...c.get("actor"), channel: "mcp" };
    const server = buildMcpServer(service, actor);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw, {
        authInfo: { token: c.get("token"), clientId: actor.clientId, scopes: actor.scopes, extra: { role: actor.role } },
      });
    } finally {
      void server.close();
    }
  });

  // REST API for the clinic's own apps. Same service, same checks, same audit log.
  const api = new Hono<Env>();
  api.use("*", requireAuth);
  const rest = (c: Context<Env>): Actor => ({ ...c.get("actor"), channel: "rest" });

  api.get("/patients", (c) => c.json(service.searchPatients(rest(c), { query: c.req.query("query") ?? "", ...(c.req.query("dob") ? { dob: c.req.query("dob")! } : {}) })));

  api.get("/patients/:id/appointments", (c) => c.json(service.patientAppointments(rest(c), c.req.param("id"))));

  api.get("/slots", (c) => {
    const q = z
      .object({
        visitType: z.enum(VISIT_TYPE_IDS),
        providerId: z.string().optional(),
        patientId: z.string().optional(),
        fromDate: z.string().regex(LOCAL_DATE).optional(),
        days: z.coerce.number().int().min(1).max(31).optional(),
        limit: z.coerce.number().int().min(1).max(50).optional(),
      })
      .parse(c.req.query());
    return c.json(service.findSlots(rest(c), q));
  });

  api.get("/providers/:id/schedule", (c) => {
    const date = z.string().regex(LOCAL_DATE).parse(c.req.query("date"));
    return c.json(service.providerSchedule(rest(c), { providerId: c.req.param("id"), date }));
  });

  api.get("/appointments/:id", (c) => c.json(service.getAppointment(rest(c), c.req.param("id"))));
  api.post("/appointments", async (c) => c.json(service.book(rest(c), BookSchema.parse(await c.req.json())), 201));
  api.patch("/appointments/:id", async (c) => {
    const { newStart } = z.object({ newStart: z.string().regex(LOCAL_DATETIME) }).parse(await c.req.json());
    return c.json(service.reschedule(rest(c), { appointmentId: c.req.param("id"), newStart }));
  });
  api.post("/appointments/:id/cancel", async (c) => {
    const { reason } = z.object({ reason: z.string().min(1).max(300) }).parse(await c.req.json());
    return c.json(service.cancel(rest(c), { appointmentId: c.req.param("id"), reason }));
  });
  api.put("/appointments/:id/note", async (c) => {
    const { note } = z.object({ note: z.string().min(1).max(2000) }).parse(await c.req.json());
    return c.json(service.addPrevisitNote(rest(c), { appointmentId: c.req.param("id"), note }));
  });
  api.get("/audit", (c) => c.json(service.auditLog(rest(c), { limit: Number(c.req.query("limit") ?? 50) })));

  api.onError((err, c) => {
    if (err instanceof ForbiddenError) return c.json({ error: "forbidden", detail: err.message }, 403);
    if (err instanceof NotFoundError) return c.json({ error: "not_found", detail: err.message }, 404);
    if (err instanceof ConflictError) return c.json({ error: "conflict", code: err.code }, 409);
    if (err instanceof z.ZodError) return c.json({ error: "invalid_request", issues: z.treeifyError(err) }, 400);
    if (err instanceof SyntaxError) return c.json({ error: "invalid_json" }, 400);
    console.error(err);
    return c.json({ error: "internal_error" }, 500);
  });

  app.route("/api", api);
  return app;
}
