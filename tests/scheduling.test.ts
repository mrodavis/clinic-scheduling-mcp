import assert from "node:assert/strict";
import { test } from "node:test";
import { PATIENTS, PROVIDERS } from "../src/domain/clinic.ts";
import { findSlots, isLateCancel, validateBooking, type Appointment, type ScheduleState } from "../src/domain/scheduling.ts";
import { ageOn, clinicNow } from "../src/domain/time.ts";

const NOW = "2026-11-16T08:00"; // Monday
const okafor = PROVIDERS.find((p) => p.id === "prv_okafor")!;
const herrera = PROVIDERS.find((p) => p.id === "prv_herrera")!;
const chen = PROVIDERS.find((p) => p.id === "prv_chen")!;
const adult = PATIENTS.find((p) => p.id === "pt_1001")!;
const child = PATIENTS.find((p) => p.id === "pt_1004")!;

const appt = (over: Partial<Appointment>): Appointment => ({
  id: "apt_x",
  patientId: "pt_1002",
  providerId: "prv_okafor",
  visitType: "follow_up",
  start: "2026-11-16T09:00",
  end: "2026-11-16T09:20",
  status: "booked",
  reason: "",
  previsitNote: null,
  createdBy: "t",
  createdAt: NOW,
  ...over,
});
const empty: ScheduleState = { appointments: [], blocks: [] };

test("slots skip the past, lunch, bookings, blocks and days off", () => {
  const state: ScheduleState = {
    appointments: [appt({})],
    blocks: [{ providerId: "prv_okafor", start: "2026-11-16T10:00", end: "2026-11-16T11:00", label: "Admin" }],
  };
  const slots = findSlots({ providers: [okafor], state, visitType: "follow_up", fromDate: "2026-11-16", days: 1, now: NOW, limit: 50 }).map((s) => s.start.slice(11));
  assert.ok(!slots.includes("08:00"), "now is not bookable");
  assert.ok(!slots.includes("09:00"), "booked");
  assert.ok(!slots.includes("10:20"), "blocked");
  assert.ok(!slots.some((t) => t >= "12:00" && t < "13:00"), "lunch");
  assert.ok(slots.includes("08:20") && slots.includes("13:00") && slots.includes("16:40"));
  assert.equal(slots.at(-1), "16:40", "last 20 minute slot ends at close");

  const tuesday = findSlots({ providers: [herrera], state: empty, visitType: "sick_visit", fromDate: "2026-11-17", days: 1, now: NOW, limit: 5 });
  assert.equal(tuesday.length, 0, "Dr. Herrera does not work Tuesdays");
});

test("a 40 minute visit never straddles lunch", () => {
  const starts = findSlots({ providers: [okafor], state: empty, visitType: "annual_physical", fromDate: "2026-11-16", days: 1, now: NOW, limit: 50 }).map((s) => s.start.slice(11));
  assert.ok(starts.includes("11:20"));
  assert.ok(!starts.includes("11:40"));
  assert.ok(!starts.includes("16:40"), "would run past close");
});

test("passing a patient filters out providers who cannot see them", () => {
  const forAdult = findSlots({ providers: PROVIDERS, state: empty, visitType: "sick_visit", fromDate: "2026-11-16", days: 1, now: NOW, limit: 50, patient: adult });
  assert.ok(forAdult.every((s) => s.providerId !== "prv_herrera"));
  const forChild = findSlots({ providers: PROVIDERS, state: empty, visitType: "sick_visit", fromDate: "2026-11-16", days: 1, now: NOW, limit: 50, patient: child });
  assert.ok(forChild.some((s) => s.providerId === "prv_herrera"));
});

test("booking rules", () => {
  const base = { patient: adult, provider: okafor, visitType: "follow_up" as const, state: empty, now: NOW };
  assert.equal(validateBooking({ ...base, start: "2026-11-16T09:00" }), null);
  assert.equal(validateBooking({ ...base, provider: herrera, start: "2026-11-16T09:00" }), "patient_age_out_of_range");
  assert.equal(validateBooking({ ...base, provider: chen, visitType: "new_patient", start: "2026-11-17T09:00" }), "provider_does_not_offer_visit_type");
  assert.equal(validateBooking({ ...base, start: "2026-11-21T09:00" }), "outside_clinic_hours", "Saturday");
  assert.equal(validateBooking({ ...base, start: "2026-11-16T12:20" }), "outside_clinic_hours", "lunch");
  assert.equal(validateBooking({ ...base, start: "2026-11-16T09:10" }), "not_on_slot_boundary");
  assert.equal(validateBooking({ ...base, start: "2026-11-16T07:40" }), "in_the_past");
  assert.equal(validateBooking({ ...base, start: "2026-11-16T09:00", state: { appointments: [appt({})], blocks: [] } }), "slot_taken");
  assert.equal(
    validateBooking({ ...base, start: "2026-11-17T09:00", provider: chen, state: { appointments: [appt({ patientId: adult.id, providerId: "prv_okafor", start: "2026-11-17T09:00", end: "2026-11-17T09:20" })], blocks: [] } }),
    "patient_double_booked",
  );
  // Rescheduling an appointment into a slot that overlaps only itself is fine.
  assert.equal(validateBooking({ ...base, patient: PATIENTS[1]!, start: "2026-11-16T09:00", state: { appointments: [appt({})], blocks: [] }, ignoreAppointmentId: "apt_x" }), null);
});

test("late cancel, age and clinic time helpers", () => {
  assert.equal(isLateCancel("2026-11-17T07:59", NOW), true);
  assert.equal(isLateCancel("2026-11-17T08:00", NOW), false);
  assert.equal(ageOn("2008-11-17", "2026-11-16"), 17);
  assert.equal(ageOn("2008-11-16", "2026-11-16"), 18);
  assert.equal(clinicNow("America/New_York", new Date("2026-07-01T16:30:00Z")), "2026-07-01T12:30", "EDT");
  assert.equal(clinicNow("America/New_York", new Date("2026-12-01T16:30:00Z")), "2026-12-01T11:30", "EST");
});
