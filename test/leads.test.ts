import { describe, expect, it } from "vitest";

import {
  findBestNameMatch,
  findPhoneByEmail,
  findVisitHistory,
  type CustomerNameRecord,
  type VisitHistory,
} from "../src/lib/leads.js";
import { memberIdFromEmail } from "../src/lib/pulse-views.js";

describe("findBestNameMatch", () => {
  const customers: CustomerNameRecord[] = [
    { name: "Maria Leonor Pinto", email: "mleopinto@gmail.com", phone: "912345678" },
    { name: "Isabella Angerer", email: "sombornisabella@gmail.com", phone: null },
    { name: "Catarina Wang", email: "catarinawang88@gmail.com", phone: "934567890" },
  ];

  it("finds an exact name match", () => {
    const match = findBestNameMatch("Maria Leonor Pinto", customers);
    expect(match?.email).toBe("mleopinto@gmail.com");
  });

  it("finds a close/partial name match above threshold", () => {
    const match = findBestNameMatch("Isabella", customers);
    expect(match?.name).toBe("Isabella Angerer");
  });

  it("returns null when nothing clears the threshold", () => {
    const match = findBestNameMatch("Zeferino Completely Unrelated", customers);
    expect(match).toBeNull();
  });

  it("returns null against an empty customer list", () => {
    expect(findBestNameMatch("Anyone", [])).toBeNull();
  });
});

describe("findVisitHistory", () => {
  const email = "maria@example.com";
  const activity = new Map<string, VisitHistory>([
    [memberIdFromEmail(email), { firstVisit: "2026-01-05", lastVisit: "2026-06-10", visitCount: 12 }],
  ]);

  it("finds visit history by email, case-insensitive", () => {
    expect(findVisitHistory("MARIA@example.com", activity)).toEqual({
      firstVisit: "2026-01-05",
      lastVisit: "2026-06-10",
      visitCount: 12,
    });
  });

  it("returns null when the email has no visit history on file", () => {
    expect(findVisitHistory("nobody@example.com", activity)).toBeNull();
  });

  it("returns null when no email is given", () => {
    expect(findVisitHistory(null, activity)).toBeNull();
  });
});

describe("findPhoneByEmail", () => {
  const customers: CustomerNameRecord[] = [
    { name: "Maria Leonor Pinto", email: "mleopinto@gmail.com", phone: "912345678" },
    { name: "Isabella Angerer", email: "sombornisabella@gmail.com", phone: null },
  ];

  it("finds a phone by exact case-insensitive email match", () => {
    expect(findPhoneByEmail("MLeoPinto@gmail.com", customers)).toBe("912345678");
  });

  it("returns null when the matched customer has no phone on file", () => {
    expect(findPhoneByEmail("sombornisabella@gmail.com", customers)).toBeNull();
  });

  it("returns null when no email is given", () => {
    expect(findPhoneByEmail(null, customers)).toBeNull();
  });

  it("returns null when the email isn't in the list", () => {
    expect(findPhoneByEmail("nobody@x.com", customers)).toBeNull();
  });
});
