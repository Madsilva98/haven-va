/**
 * Error UX strings + small helpers.
 * - `ERROR_MESSAGE` is the rate-limited group-facing notice.
 * - `ErrorRateLimit` ensures the bot does not spam the group.
 * - `confirmationMessages` are the single-line follow-ups posted after
 *   a user reacts to a proposal (or after a pending one expires).
 */

import type { Priority } from "../types.js";

export const ERROR_MESSAGE =
  "⚠️ haven ops está com um problema. apanho isto mais tarde, podem registar manualmente no Notion entretanto.";

const THIRTY_MIN_MS = 30 * 60 * 1000;

/**
 * Rate-limits user-facing error notifications. `tryNotify()` returns
 * true at most once every 30 minutes; subsequent calls within the
 * window return false and the caller suppresses the notice.
 */
export class ErrorRateLimit {
  private lastNotifiedAt = 0;
  private readonly windowMs: number;

  constructor(windowMs: number = THIRTY_MIN_MS) {
    this.windowMs = windowMs;
  }

  tryNotify(): boolean {
    const now = Date.now();
    if (now - this.lastNotifiedAt >= this.windowMs) {
      this.lastNotifiedAt = now;
      return true;
    }
    return false;
  }

  reset(): void {
    this.lastNotifiedAt = 0;
  }
}

/**
 * Single-line confirmation strings. Lowercase, no fanfare.
 * Match spec § "After confirm" / "After cancel".
 */
export const confirmationMessages = {
  newTaskAdded(priority: Priority): string {
    return `✅ adicionado ao backlog (${priority.toLowerCase()})`;
  },
  editApplied(): string {
    return "✅ atualizado";
  },
  newTaskIgnored(): string {
    return "❌ ignorado";
  },
  editIgnored(): string {
    return "❌ deixei como estava";
  },
  pendingExpired(): string {
    return "esta proposta expirou, fala outra vez";
  },
};
