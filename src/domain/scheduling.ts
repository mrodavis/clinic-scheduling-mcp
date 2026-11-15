import { CLINIC, VISIT_TYPES, type Patient, type Provider, type VisitType } from "./clinic.ts";
import { addDays, addMinutes, ageOn, dateOf, dayOfWeek, toMinutes, type LocalDate, type LocalDateTime } from "./time.ts";

export interface Appointment {
  id: string;
  patientId: string;
  providerId: string;
  visitType: VisitType;
  start: LocalDateTime;
  end: LocalDateTime;
  status: "booked" | "cancelled";
  /** Patient-stated reason. Free text supplied by people, so treat it as untrusted. */
  reason: string;
  /** Clinician-only pre-visit note. */
  previsitNote: string | null;
  createdBy: string;
  createdAt: string;
  cancelReason?: string;
  lateCancel?: boolean;
}

export interface Block {
  providerId: string;
  start: LocalDateTime;
  end: LocalDateTime;
  label: string;
}

export interface Slot {
  providerId: string;
  providerName: string;
  start: LocalDateTime;
  end: LocalDateTime;
}

export type BookingError =
  | "provider_does_not_offer_visit_type"
  | "patient_age_out_of_range"
  | "outside_clinic_hours"
  | "not_on_slot_boundary"
  | "in_the_past"
  | "slot_taken"
  | "patient_double_booked";

const overlaps = (aStart: LocalDateTime, aEnd: LocalDateTime, bStart: LocalDateTime, bEnd: LocalDateTime) =>
  toMinutes(aStart) < toMinutes(bEnd) && toMinutes(bStart) < toMinutes(aEnd);

function withinHours(start: LocalDateTime, end: LocalDateTime): boolean {
  const d = dateOf(start);
  if (dateOf(end) !== d && !end.endsWith("T00:00")) return false;
  const open = `${d}T${CLINIC.open}`;
  const close = `${d}T${CLINIC.close}`;
  const lunchStart = `${d}T${CLINIC.lunch.start}`;
  const lunchEnd = `${d}T${CLINIC.lunch.end}`;
  return toMinutes(start) >= toMinutes(open) && toMinutes(end) <= toMinutes(close) && !overlaps(start, end, lunchStart, lunchEnd);
}

export interface ScheduleState {
  appointments: Appointment[];
  blocks: Block[];
}

function providerBusy(state: ScheduleState, providerId: string, start: LocalDateTime, end: LocalDateTime, ignoreId?: string): boolean {
  return (
    state.appointments.some((a) => a.status === "booked" && a.providerId === providerId && a.id !== ignoreId && overlaps(start, end, a.start, a.end)) ||
    state.blocks.some((b) => b.providerId === providerId && overlaps(start, end, b.start, b.end))
  );
}

/** Pure booking rules. Returns the first rule the booking breaks, or null. */
export function validateBooking(args: {
  provider: Provider;
  patient: Patient;
  visitType: VisitType;
  start: LocalDateTime;
  state: ScheduleState;
  now: LocalDateTime;
  /** When rescheduling, the appointment being moved does not conflict with itself. */
  ignoreAppointmentId?: string;
}): BookingError | null {
  const { provider, patient, visitType, start, state, now } = args;
  const end = addMinutes(start, VISIT_TYPES[visitType].minutes);

  if (!provider.visitTypes.includes(visitType)) return "provider_does_not_offer_visit_type";
  if (provider.maxPatientAge !== undefined && ageOn(patient.dob, dateOf(start)) > provider.maxPatientAge) return "patient_age_out_of_range";
  if (toMinutes(start) <= toMinutes(now)) return "in_the_past";
  if ((toMinutes(start) - toMinutes(`${dateOf(start)}T${CLINIC.open}`)) % CLINIC.slotMinutes !== 0) return "not_on_slot_boundary";
  if (!provider.workDays.includes(dayOfWeek(dateOf(start))) || !withinHours(start, end)) return "outside_clinic_hours";
  if (providerBusy(state, provider.id, start, end, args.ignoreAppointmentId)) return "slot_taken";
  const patientBusy = state.appointments.some(
    (a) => a.status === "booked" && a.patientId === patient.id && a.id !== args.ignoreAppointmentId && overlaps(start, end, a.start, a.end),
  );
  if (patientBusy) return "patient_double_booked";
  return null;
}

/** Open slots for a visit type, earliest first, across one or all providers. */
export function findSlots(args: {
  providers: Provider[];
  state: ScheduleState;
  visitType: VisitType;
  fromDate: LocalDate;
  days: number;
  now: LocalDateTime;
  limit: number;
  patient?: Patient;
}): Slot[] {
  const minutes = VISIT_TYPES[args.visitType].minutes;
  const slots: Slot[] = [];
  for (let i = 0; i < args.days; i++) {
    const d = addDays(args.fromDate, i);
    for (let t = `${d}T${CLINIC.open}`; toMinutes(t) < toMinutes(`${d}T${CLINIC.close}`); t = addMinutes(t, CLINIC.slotMinutes)) {
      for (const p of args.providers) {
        if (!p.visitTypes.includes(args.visitType)) continue;
        if (args.patient && p.maxPatientAge !== undefined && ageOn(args.patient.dob, d) > p.maxPatientAge) continue;
        const end = addMinutes(t, minutes);
        if (toMinutes(t) <= toMinutes(args.now)) continue;
        if (!p.workDays.includes(dayOfWeek(d)) || !withinHours(t, end)) continue;
        if (providerBusy(args.state, p.id, t, end)) continue;
        slots.push({ providerId: p.id, providerName: p.name, start: t, end });
        if (slots.length >= args.limit) return slots;
      }
    }
  }
  return slots;
}

export function isLateCancel(start: LocalDateTime, now: LocalDateTime): boolean {
  return toMinutes(start) - toMinutes(now) < CLINIC.lateCancelHours * 60;
}
