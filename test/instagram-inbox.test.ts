import { describe, expect, it } from "vitest";

import {
  buildTranscript,
  extractVolunteeredEmail,
  extractVolunteeredPhone,
  groupMessagesByContact,
  isExcludedInstagramContact,
  type InstagramTranscriptMessage,
} from "../src/lib/instagram-inbox.js";

describe("buildTranscript", () => {
  it("renders both directions chronologically, labelled Cliente/Haven", () => {
    const messages: InstagramTranscriptMessage[] = [
      { direction: "in", text: "Olá, quanto custa a mensalidade?", sentAt: "2026-01-01T10:00:00Z" },
      { direction: "out", text: "Olá! Temos planos a partir de 60€.", sentAt: "2026-01-01T10:05:00Z" },
    ];
    expect(buildTranscript(messages)).toBe(
      "Cliente: Olá, quanto custa a mensalidade?\nHaven: Olá! Temos planos a partir de 60€.",
    );
  });

  it("skips messages with no text (e.g. media-only)", () => {
    const messages: InstagramTranscriptMessage[] = [
      { direction: "in", text: null, sentAt: "2026-01-01T10:00:00Z" },
      { direction: "in", text: "Oi", sentAt: "2026-01-01T10:01:00Z" },
    ];
    expect(buildTranscript(messages)).toBe("Cliente: Oi");
  });

  it("returns an empty string for no messages", () => {
    expect(buildTranscript([])).toBe("");
  });

  it("truncates to maxChars from the start", () => {
    const messages: InstagramTranscriptMessage[] = [{ direction: "in", text: "a".repeat(100), sentAt: "x" }];
    expect(buildTranscript(messages, 20)).toHaveLength(20);
  });
});

describe("extractVolunteeredEmail", () => {
  it("finds an email in an inbound message", () => {
    const messages: InstagramTranscriptMessage[] = [
      { direction: "in", text: "podem contactar-me em maria@example.com", sentAt: "x" },
    ];
    expect(extractVolunteeredEmail(messages)).toBe("maria@example.com");
  });

  it("ignores emails in outbound (our own) messages", () => {
    const messages: InstagramTranscriptMessage[] = [
      { direction: "out", text: "responde para geral@thehavenpilates.pt", sentAt: "x" },
    ];
    expect(extractVolunteeredEmail(messages)).toBeNull();
  });

  it("returns null when no email is present", () => {
    const messages: InstagramTranscriptMessage[] = [{ direction: "in", text: "quanto custa?", sentAt: "x" }];
    expect(extractVolunteeredEmail(messages)).toBeNull();
  });
});

describe("extractVolunteeredPhone", () => {
  it("finds a phone number in an inbound message", () => {
    const messages: InstagramTranscriptMessage[] = [
      { direction: "in", text: "o meu número é 912345678", sentAt: "x" },
    ];
    expect(extractVolunteeredPhone(messages)).toBe("912345678");
  });

  it("ignores phone numbers in outbound messages", () => {
    const messages: InstagramTranscriptMessage[] = [
      { direction: "out", text: "liga-nos para 912345678", sentAt: "x" },
    ];
    expect(extractVolunteeredPhone(messages)).toBeNull();
  });

  it("returns null when nothing digit-heavy is present", () => {
    const messages: InstagramTranscriptMessage[] = [{ direction: "in", text: "olá, tudo bem?", sentAt: "x" }];
    expect(extractVolunteeredPhone(messages)).toBeNull();
  });
});

describe("isExcludedInstagramContact", () => {
  it("excludes by display name, case/diacritic-insensitive", () => {
    expect(isExcludedInstagramContact({ displayName: "MADALENA marques DA SILVA", username: null })).toBe(true);
  });

  it("excludes by username", () => {
    expect(isExcludedInstagramContact({ displayName: "Someone Else", username: "maryintheskyy" })).toBe(true);
  });

  it("does not exclude an unrelated contact", () => {
    expect(isExcludedInstagramContact({ displayName: "Joana Ferreira", username: "joanaf" })).toBe(false);
  });
});

describe("groupMessagesByContact", () => {
  it("attaches each contact's messages and keeps unrelated contacts separate", () => {
    const contacts = [
      { id: "c1", platform_user_id: "p1", display_name: "A", username: null, message_count: 2 },
      { id: "c2", platform_user_id: "p2", display_name: "B", username: null, message_count: 0 },
    ];
    const messages = [
      { contact_id: "c1", direction: "in" as const, text: "oi", sent_at: "2026-01-01T00:00:00Z" },
      { contact_id: "c1", direction: "out" as const, text: "olá", sent_at: "2026-01-01T00:01:00Z" },
    ];
    const result = groupMessagesByContact(contacts, messages);
    expect(result.find((c) => c.id === "c1")?.messages).toHaveLength(2);
    expect(result.find((c) => c.id === "c2")?.messages).toHaveLength(0);
  });
});
