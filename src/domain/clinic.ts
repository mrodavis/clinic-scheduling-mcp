/**
 * Synthetic data for a FICTIONAL clinic, Bayview Family Clinic. Every provider,
 * patient and phone number is invented. No real patient data belongs in this repo.
 */
export const CLINIC = {
  name: "Bayview Family Clinic",
  timeZone: "America/New_York",
  slotMinutes: 20,
  open: "08:00",
  close: "17:00",
  lunch: { start: "12:00", end: "13:00" },
  lateCancelHours: 24,
};

export const VISIT_TYPES = {
  new_patient: { label: "New patient visit", minutes: 40 },
  annual_physical: { label: "Annual physical", minutes: 40 },
  follow_up: { label: "Follow-up", minutes: 20 },
  sick_visit: { label: "Sick visit", minutes: 20 },
  telehealth: { label: "Telehealth check-in", minutes: 20 },
} as const;
export type VisitType = keyof typeof VISIT_TYPES;
export const VISIT_TYPE_IDS = Object.keys(VISIT_TYPES) as [VisitType, ...VisitType[]];

export interface Provider {
  id: string;
  name: string;
  specialty: "family_medicine" | "pediatrics";
  /** 0 = Sunday ... 6 = Saturday */
  workDays: number[];
  visitTypes: VisitType[];
  maxPatientAge?: number;
}

export const PROVIDERS: Provider[] = [
  {
    id: "prv_okafor",
    name: "Dr. Amara Okafor",
    specialty: "family_medicine",
    workDays: [1, 2, 3, 4, 5],
    visitTypes: ["new_patient", "annual_physical", "follow_up", "sick_visit", "telehealth"],
  },
  {
    id: "prv_herrera",
    name: "Dr. Luis Herrera",
    specialty: "pediatrics",
    workDays: [1, 3, 5],
    visitTypes: ["new_patient", "annual_physical", "follow_up", "sick_visit"],
    maxPatientAge: 17,
  },
  {
    id: "prv_chen",
    name: "Jamie Chen, NP",
    specialty: "family_medicine",
    workDays: [2, 4],
    visitTypes: ["follow_up", "sick_visit", "telehealth"],
  },
];

export interface Patient {
  id: string;
  name: string;
  dob: string;
  phone: string;
}

export const PATIENTS: Patient[] = [
  { id: "pt_1001", name: "Maria Santos", dob: "1984-03-12", phone: "555-0101" },
  { id: "pt_1002", name: "James Whitaker", dob: "1958-11-30", phone: "555-0102" },
  { id: "pt_1003", name: "Aisha Rahman", dob: "1992-07-04", phone: "555-0103" },
  { id: "pt_1004", name: "Noah Kim", dob: "2016-05-21", phone: "555-0104" },
  { id: "pt_1005", name: "Sofia Rossi", dob: "2019-09-09", phone: "555-0105" },
  { id: "pt_1006", name: "Daniel Okoye", dob: "1975-01-17", phone: "555-0106" },
  { id: "pt_1007", name: "Maria Santiago", dob: "2001-12-02", phone: "555-0107" },
  { id: "pt_1008", name: "Evelyn Brooks", dob: "1949-04-25", phone: "555-0108" },
];
