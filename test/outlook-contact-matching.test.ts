import { describe, expect, it } from "vitest";

import {
  buildContactLookups,
  domainOf,
  guessExternalParty,
  matchKnownContact,
  normalize,
} from "../src/lib/outlook-contact-matching.js";

const OWN_DOMAINS = new Set(["thehavenpilates.pt"]);

describe("guessExternalParty", () => {
  it("uses the sender directly when the sender is external", () => {
    const result = guessExternalParty(
      { name: "Sarah P", email: "sarah@gokenko.com" },
      [{ name: "Haven", email: "madalena@thehavenpilates.pt" }],
      OWN_DOMAINS,
    );
    expect(result).toEqual({ name: "Sarah P", email: "sarah@gokenko.com" });
  });

  it("falls back to the external recipient when the Haven itself sent the message", () => {
    const result = guessExternalParty(
      { name: "Partners", email: "partners@thehavenpilates.pt" },
      [{ name: "Aina Paulí", email: "aina@chiostudio.example" }],
      OWN_DOMAINS,
    );
    expect(result).toEqual({ name: "Aina Paulí", email: "aina@chiostudio.example" });
  });

  it("returns null for an internal-only forward — no external recipient to guess a name from", () => {
    // Regression for a real incident (2026-09-22): before this fix,
    // guessExternalParty fell back to the SENDER's own name here, which for
    // a founder's personal mailbox produced a real, plausible-looking
    // person's name ("Madalena Marques Da Silva") instead of an obviously
    // wrong placeholder — silently creating pages titled after a founder.
    const result = guessExternalParty(
      { name: "Madalena Marques Da Silva", email: "madalena@thehavenpilates.pt" },
      [
        { name: "Mafalda Saudade", email: "mafalda@thehavenpilates.pt" },
        { name: "Beatriz Rogério", email: "beatriz@thehavenpilates.pt" },
      ],
      OWN_DOMAINS,
    );
    expect(result).toBeNull();
  });

  it("still returns null when the sender is a generic shared mailbox with no external recipient", () => {
    const result = guessExternalParty(
      { name: "Geral", email: "geral@thehavenpilates.pt" },
      [{ name: "Marketing", email: "marketing@thehavenpilates.pt" }],
      OWN_DOMAINS,
    );
    expect(result).toBeNull();
  });

  it("returns null (not the sender's own name) even with an empty recipient list", () => {
    const result = guessExternalParty(
      { name: "Madalena Marques Da Silva", email: "madalena@thehavenpilates.pt" },
      [],
      OWN_DOMAINS,
    );
    expect(result).toBeNull();
  });
});

describe("matchKnownContact / buildContactLookups", () => {
  const contacts = [{ id: "page-1", name: "Chio Studio", email: "aina@chiostudio.example" }];
  const lookups = buildContactLookups(contacts, OWN_DOMAINS);

  it("matches an exact email as certain identity", () => {
    const match = matchKnownContact(
      { name: "Aina", email: "aina@chiostudio.example" },
      [{ name: "Haven", email: "hello@thehavenpilates.pt" }],
      OWN_DOMAINS,
      lookups,
    );
    expect(match).toEqual({ contact: contacts[0], matchBasis: "exact_email" });
  });

  it("returns null when nothing matches", () => {
    const match = matchKnownContact(
      { name: "Someone Else", email: "someone@unrelated.example" },
      [],
      OWN_DOMAINS,
      lookups,
    );
    expect(match).toBeNull();
  });
});

describe("domainOf / normalize", () => {
  it("extracts a lowercase domain from an email address", () => {
    expect(domainOf("Someone@Example.COM")).toBe("example.com");
  });

  it("folds accents and lowercases for keyword-style matching", () => {
    expect(normalize("Parceria com Ênfase")).toBe("parceria com enfase");
  });
});
