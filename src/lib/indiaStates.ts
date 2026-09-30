/** 28 states + 8 union territories — the only values an Indian address's `state` may take. */
export const INDIA_STATES = [
  "Andhra Pradesh",
  "Arunachal Pradesh",
  "Assam",
  "Bihar",
  "Chhattisgarh",
  "Goa",
  "Gujarat",
  "Haryana",
  "Himachal Pradesh",
  "Jharkhand",
  "Karnataka",
  "Kerala",
  "Madhya Pradesh",
  "Maharashtra",
  "Manipur",
  "Meghalaya",
  "Mizoram",
  "Nagaland",
  "Odisha",
  "Punjab",
  "Rajasthan",
  "Sikkim",
  "Tamil Nadu",
  "Telangana",
  "Tripura",
  "Uttar Pradesh",
  "Uttarakhand",
  "West Bengal",
  "Andaman and Nicobar Islands",
  "Chandigarh",
  "Dadra and Nagar Haveli and Daman and Diu",
  "Delhi",
  "Jammu and Kashmir",
  "Ladakh",
  "Lakshadweep",
  "Puducherry",
] as const;

const byLowerCase = new Map(INDIA_STATES.map((s) => [s.toLowerCase(), s]));

/** Case/whitespace-insensitive match to the canonical spelling, or null. */
export function canonicalIndiaState(input: string): string | null {
  return byLowerCase.get(input.trim().replace(/\s+/g, " ").toLowerCase()) ?? null;
}

export const INDIA_PIN_CODE = /^[1-9][0-9]{5}$/;
