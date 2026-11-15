import { appendFileSync } from "node:fs";
import { PATIENTS, PROVIDERS, type Patient, type Provider } from "./domain/clinic.ts";
import type { Appointment, Block } from "./domain/scheduling.ts";
import { addDays, dateOf, dayOfWeek, type LocalDateTime } from "./domain/time.ts";
import type { Action, Role } from "./permissions.ts";

export interface AuditEntry {
  at: string;
  actorId: string;
  role: Role;
  clientId: string;
  channel: "mcp" | "rest";
  action: Action;
  outcome: "allowed" | "denied" | "rejected";
  /** IDs only. Names, reasons and notes never go in the audit log. */
  target?: { patientId?: string; appointmentId?: string; providerId?: string };
  code?: string;
}

export class ClinicStore {
  providers: Provider[] = PROVIDERS;
  patients: Patient[] = PATIENTS;
  appointments: Appointment[] = [];
  blocks: Block[] = [];
  audit: AuditEntry[] = [];
  idempotency = new Map<string, string>();
  private seq = 0;

  constructor(private auditPath = process.env.AUDIT_LOG_PATH) {}

  nextAppointmentId(): string {
    this.seq++;
    return `apt_${String(this.seq).padStart(4, "0")}`;
  }

  writeAudit(e: AuditEntry): void {
    this.audit.push(e);
    if (this.auditPath) appendFileSync(this.auditPath, JSON.stringify(e) + "\n");
  }
}

function nextWeekday(from: string, weekday: number): string {
  let d = from;
  while (dayOfWeek(d) !== weekday) d = addDays(d, 1);
  return d;
}

/** A few synthetic appointments and a block, relative to "now", so the demo has a realistic schedule. */
export function seedStore(store: ClinicStore, now: LocalDateTime): ClinicStore {
  const today = dateOf(now);
  const mon = nextWeekday(addDays(today, 1), 1);
  const tue = addDays(mon, 1);
  const add = (patientId: string, providerId: string, visitType: Appointment["visitType"], start: string, end: string, reason: string) =>
    store.appointments.push({
      id: store.nextAppointmentId(),
      patientId,
      providerId,
      visitType,
      start,
      end,
      status: "booked",
      reason,
      previsitNote: null,
      createdBy: "seed",
      createdAt: now,
    });
  add("pt_1002", "prv_okafor", "follow_up", `${mon}T09:00`, `${mon}T09:20`, "Blood pressure recheck");
  add("pt_1004", "prv_herrera", "sick_visit", `${mon}T10:00`, `${mon}T10:20`, "Sore throat and fever");
  add("pt_1006", "prv_chen", "telehealth", `${tue}T14:00`, `${tue}T14:20`, "Medication question");
  store.blocks.push({ providerId: "prv_okafor", start: `${tue}T08:00`, end: `${tue}T10:00`, label: "Hospital rounds" });
  return store;
}
