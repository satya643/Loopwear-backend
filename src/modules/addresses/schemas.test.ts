import { describe, expect, it } from "vitest";
import { createAddressSchema, updateAddressSchema } from "./schemas";

const valid = {
  fullName: "Asha Rao",
  phone: "+919876543210",
  line1: "H No. 12, 4th Cross",
  city: "Bengaluru",
  state: "Karnataka",
  postalCode: "560001",
};

describe("createAddressSchema", () => {
  it("accepts a complete Indian address and fills defaults", () => {
    expect(createAddressSchema.parse(valid)).toMatchObject({ ...valid, label: "Home", country: "IN" });
  });

  it("normalises a 10-digit mobile to E.164 and the state to its canonical spelling", () => {
    const parsed = createAddressSchema.parse({ ...valid, phone: "98765 43210", state: "  tamil   nadu " });
    expect(parsed.phone).toBe("+919876543210");
    expect(parsed.state).toBe("Tamil Nadu");
  });

  it("strips control characters and collapses whitespace", () => {
    const parsed = createAddressSchema.parse({ ...valid, line1: "  Flat 3\n\tMG   Road ", line2: "   " });
    expect(parsed.line1).toBe("Flat 3 MG Road");
    expect(parsed.line2).toBeUndefined();
  });

  it.each([
    ["postalCode", "56001", "PIN"],
    ["postalCode", "060001", "PIN"],
    ["state", "Atlantis", "state"],
    ["country", "US", "India"],
    ["fullName", "12", "letters"],
    ["city", "Bengaluru 1", "City"],
    ["phone", "12345", "Phone"],
  ])("rejects an invalid %s (%s)", (field, value, message) => {
    const result = createAddressSchema.safeParse({ ...valid, [field]: value });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === field);
      expect(issue?.message).toMatch(new RegExp(message, "i"));
    }
  });

  it("requires the mandatory fields", () => {
    const result = createAddressSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = new Set(result.error.issues.map((i) => i.path[0]));
      for (const f of ["fullName", "phone", "line1", "city", "state", "postalCode"]) expect(fields.has(f)).toBe(true);
    }
  });
});

describe("updateAddressSchema", () => {
  it("accepts partial updates without re-applying defaults", () => {
    expect(updateAddressSchema.parse({ city: "Mysuru" })).toEqual({ city: "Mysuru" });
  });

  it("rejects an empty update", () => {
    expect(updateAddressSchema.safeParse({}).success).toBe(false);
  });
});
