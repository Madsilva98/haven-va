import { describe, expect, it } from "vitest";

import { findBestNameMatch, type CustomerNameRecord } from "../src/lib/leads.js";

describe("findBestNameMatch", () => {
  const customers: CustomerNameRecord[] = [
    { name: "Maria Leonor Pinto", email: "mleopinto@gmail.com" },
    { name: "Isabella Angerer", email: "sombornisabella@gmail.com" },
    { name: "Catarina Wang", email: "catarinawang88@gmail.com" },
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
