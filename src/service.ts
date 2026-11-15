import { VISIT_TYPES, type VisitType } from "./domain/clinic.ts";
import { findSlots, isLateCancel, validateBooking, type Appointment, type BookingError } from "./domain/scheduling.ts";
import { addMinutes, dateOf, type LocalDate, type LocalDateTime } from "./domain/time.ts";
import { can, type Action, type Actor } from "./permissions.ts";
import type { AuditEntry, ClinicStore } from "./store.ts";

export class ForbiddenError extends Error {}
export class NotFoundError extends Error {}
export class ConflictError extends Error {
  constructor(readonly code: BookingError | "already_cancelled" | "idempotency_key_reused") {
    super(code);
  }
}

type Target = AuditEntry["target"];

/**
 * The one place clinic data is read or changed. The REST API and the MCP tools
 * both call this, so a permission check or audit entry cannot exist in one
 * channel and be missing from the other.
 */
export class ClinicService {
  constructor(
    private store: ClinicStore,
    private now: () => LocalDateTime,
  ) {}

  can(actor: Actor, action: Action): boolean {
    return can(actor, action);
  }

  private log(actor: Actor, action: Action, outcome: AuditEntry["outcome"], target?: Target, code?: string): void {
    this.store.writeAudit({
      at: new Date().toISOString(),
      actorId: actor.id,
      role: actor.role,
      clientId: actor.clientId,
      channel: actor.channel,
      action,
      outcome,
      ...(target ? { target } : {}),
      ...(code ? { code } : {}),
    });
  }

  private authorize(actor: Actor, action: Action, target?: Target): void {
    if (!can(actor, action)) {
      this.log(actor, action, "denied", target, "role_or_scope");
      throw new ForbiddenError(`${actor.role} with this token cannot ${action}`);
    }
  }

  private patient(id: string) {
    const p = this.store.patients.find((x) => x.id === id);
    if (!p) throw new NotFoundError(`patient ${id} not found`);
    return p;
  }

  private provider(id: string) {
    const p = this.store.providers.find((x) => x.id === id);
    if (!p) throw new NotFoundError(`provider ${id} not found`);
    return p;
  }

  private appointment(id: string) {
    const a = this.store.appointments.find((x) => x.id === id);
    if (!a) throw new NotFoundError(`appointment ${id} not found`);
    return a;
  }

  /** Shape returned to callers. The pre-visit note is shown only to the clinician whose appointment it is. */
  private view(actor: Actor, a: Appointment) {
    const showNote = actor.role === "clinician" && actor.providerId === a.providerId;
    return {
      id: a.id,
      patient: { id: a.patientId, name: this.patient(a.patientId).name },
      provider: { id: a.providerId, name: this.provider(a.providerId).name },
      visitType: a.visitType,
      start: a.start,
      end: a.end,
      status: a.status,
      reason: a.reason,
      ...(showNote ? { previsitNote: a.previsitNote } : {}),
      ...(a.status === "cancelled" ? { cancelReason: a.cancelReason, lateCancel: a.lateCancel } : {}),
    };
  }

  searchPatients(actor: Actor, q: { query: string; dob?: string }) {
    this.authorize(actor, "patients.search");
    const needle = q.query.trim().toLowerCase();
    const results = this.store.patients
      .filter((p) => p.name.toLowerCase().includes(needle) && (!q.dob || p.dob === q.dob))
      .slice(0, 10)
      .map((p) => ({ id: p.id, name: p.name, dob: p.dob, phoneLast4: p.phone.slice(-4) }));
    this.log(actor, "patients.search", "allowed");
    return results;
  }

  findSlots(actor: Actor, q: { visitType: VisitType; providerId?: string; patientId?: string; fromDate?: LocalDate; days?: number; limit?: number }) {
    this.authorize(actor, "slots.find");
    const providers = q.providerId ? [this.provider(q.providerId)] : this.store.providers;
    const slots = findSlots({
      providers,
      state: this.store,
      visitType: q.visitType,
      fromDate: q.fromDate ?? dateOf(this.now()),
      days: Math.min(q.days ?? 7, 31),
      now: this.now(),
      limit: Math.min(q.limit ?? 10, 50),
      ...(q.patientId ? { patient: this.patient(q.patientId) } : {}),
    });
    this.log(actor, "slots.find", "allowed", q.providerId ? { providerId: q.providerId } : undefined);
    return slots;
  }

  providerSchedule(actor: Actor, q: { providerId: string; date: LocalDate }) {
    this.authorize(actor, "schedule.view", { providerId: q.providerId });
    const provider = this.provider(q.providerId);
    const appointments = this.store.appointments
      .filter((a) => a.providerId === provider.id && dateOf(a.start) === q.date && a.status === "booked")
      .sort((a, b) => a.start.localeCompare(b.start))
      .map((a) => this.view(actor, a));
    const blocks = this.store.blocks.filter((b) => b.providerId === provider.id && dateOf(b.start) === q.date);
    this.log(actor, "schedule.view", "allowed", { providerId: provider.id });
    return { provider: { id: provider.id, name: provider.name }, date: q.date, appointments, blocks };
  }

  getAppointment(actor: Actor, id: string) {
    this.authorize(actor, "appointment.view", { appointmentId: id });
    const a = this.appointment(id);
    this.log(actor, "appointment.view", "allowed", { appointmentId: a.id, patientId: a.patientId });
    return this.view(actor, a);
  }

  patientAppointments(actor: Actor, patientId: string) {
    this.authorize(actor, "appointment.view", { patientId });
    const patient = this.patient(patientId);
    const upcoming = this.store.appointments
      .filter((a) => a.patientId === patient.id && a.status === "booked" && a.start > this.now())
      .sort((a, b) => a.start.localeCompare(b.start))
      .map((a) => this.view(actor, a));
    this.log(actor, "appointment.view", "allowed", { patientId: patient.id });
    return upcoming;
  }

  book(actor: Actor, input: { patientId: string; providerId: string; visitType: VisitType; start: LocalDateTime; reason: string; idempotencyKey?: string }) {
    const target = { patientId: input.patientId, providerId: input.providerId };
    this.authorize(actor, "appointment.book", target);

    // Agents retry. The same key from the same caller returns the original booking instead of a second one.
    const key = input.idempotencyKey ? `${actor.id}:${input.idempotencyKey}` : undefined;
    if (key && this.store.idempotency.has(key)) {
      const existing = this.appointment(this.store.idempotency.get(key)!);
      if (existing.patientId !== input.patientId || existing.start !== input.start || existing.providerId !== input.providerId) {
        throw new ConflictError("idempotency_key_reused");
      }
      return this.view(actor, existing);
    }

    const patient = this.patient(input.patientId);
    const provider = this.provider(input.providerId);
    const error = validateBooking({ provider, patient, visitType: input.visitType, start: input.start, state: this.store, now: this.now() });
    if (error) {
      this.log(actor, "appointment.book", "rejected", target, error);
      throw new ConflictError(error);
    }

    const a: Appointment = {
      id: this.store.nextAppointmentId(),
      patientId: patient.id,
      providerId: provider.id,
      visitType: input.visitType,
      start: input.start,
      end: addMinutes(input.start, VISIT_TYPES[input.visitType].minutes),
      status: "booked",
      reason: input.reason,
      previsitNote: null,
      createdBy: actor.id,
      createdAt: new Date().toISOString(),
    };
    this.store.appointments.push(a);
    if (key) this.store.idempotency.set(key, a.id);
    this.log(actor, "appointment.book", "allowed", { ...target, appointmentId: a.id });
    return this.view(actor, a);
  }

  reschedule(actor: Actor, input: { appointmentId: string; newStart: LocalDateTime }) {
    this.authorize(actor, "appointment.reschedule", { appointmentId: input.appointmentId });
    const a = this.appointment(input.appointmentId);
    const target = { appointmentId: a.id, patientId: a.patientId, providerId: a.providerId };
    if (a.status === "cancelled") throw new ConflictError("already_cancelled");
    const error = validateBooking({
      provider: this.provider(a.providerId),
      patient: this.patient(a.patientId),
      visitType: a.visitType,
      start: input.newStart,
      state: this.store,
      now: this.now(),
      ignoreAppointmentId: a.id,
    });
    if (error) {
      this.log(actor, "appointment.reschedule", "rejected", target, error);
      throw new ConflictError(error);
    }
    a.start = input.newStart;
    a.end = addMinutes(input.newStart, VISIT_TYPES[a.visitType].minutes);
    this.log(actor, "appointment.reschedule", "allowed", target);
    return this.view(actor, a);
  }

  cancel(actor: Actor, input: { appointmentId: string; reason: string }) {
    this.authorize(actor, "appointment.cancel", { appointmentId: input.appointmentId });
    const a = this.appointment(input.appointmentId);
    if (a.status === "cancelled") throw new ConflictError("already_cancelled");
    a.status = "cancelled";
    a.cancelReason = input.reason;
    a.lateCancel = isLateCancel(a.start, this.now());
    this.log(actor, "appointment.cancel", "allowed", { appointmentId: a.id, patientId: a.patientId }, a.lateCancel ? "late_cancel" : undefined);
    return this.view(actor, a);
  }

  addPrevisitNote(actor: Actor, input: { appointmentId: string; note: string }) {
    this.authorize(actor, "note.write", { appointmentId: input.appointmentId });
    const a = this.appointment(input.appointmentId);
    // Role and scope are not enough: a clinician may only annotate their own patients' visits.
    if (actor.providerId !== a.providerId) {
      this.log(actor, "note.write", "denied", { appointmentId: a.id }, "not_own_patient");
      throw new ForbiddenError("clinicians can only add notes to their own appointments");
    }
    a.previsitNote = input.note;
    this.log(actor, "note.write", "allowed", { appointmentId: a.id, patientId: a.patientId });
    return this.view(actor, a);
  }

  auditLog(actor: Actor, q: { limit?: number; actorId?: string }) {
    this.authorize(actor, "audit.view");
    const entries = this.store.audit.filter((e) => !q.actorId || e.actorId === q.actorId).slice(-Math.min(q.limit ?? 50, 500));
    this.log(actor, "audit.view", "allowed");
    return entries;
  }
}
