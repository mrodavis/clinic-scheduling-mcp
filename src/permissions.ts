export const ROLES = ["front_desk", "clinician", "admin"] as const;
export type Role = (typeof ROLES)[number];
export type Scope = "clinic:read" | "clinic:write";

export interface Actor {
  id: string;
  name: string;
  role: Role;
  /** Set for clinicians: which provider's appointments are theirs. */
  providerId?: string;
  /** Scopes granted to this token. A role can only use what the token also allows. */
  scopes: string[];
  clientId: string;
  channel: "mcp" | "rest";
}

/**
 * Least privilege, two ways: the person's ROLE must allow the action AND the
 * TOKEN must carry the scope. An admin connecting a client with a read-only
 * token gets read-only tools.
 */
export const PERMISSIONS = {
  "patients.search": { roles: ["front_desk", "clinician", "admin"], scope: "clinic:read" },
  "slots.find": { roles: ["front_desk", "clinician", "admin"], scope: "clinic:read" },
  "schedule.view": { roles: ["front_desk", "clinician", "admin"], scope: "clinic:read" },
  "appointment.view": { roles: ["front_desk", "clinician", "admin"], scope: "clinic:read" },
  "appointment.book": { roles: ["front_desk", "admin"], scope: "clinic:write" },
  "appointment.reschedule": { roles: ["front_desk", "admin"], scope: "clinic:write" },
  "appointment.cancel": { roles: ["front_desk", "admin"], scope: "clinic:write" },
  "note.write": { roles: ["clinician"], scope: "clinic:write" },
  "audit.view": { roles: ["admin"], scope: "clinic:read" },
} as const satisfies Record<string, { roles: readonly Role[]; scope: Scope }>;

export type Action = keyof typeof PERMISSIONS;

export function can(actor: Pick<Actor, "role" | "scopes">, action: Action): boolean {
  const rule = PERMISSIONS[action];
  return (rule.roles as readonly Role[]).includes(actor.role) && actor.scopes.includes(rule.scope);
}
