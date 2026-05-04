/**
 * Error UX strings + small helpers.
 * - `ERROR_MESSAGE` is the rate-limited group-facing notice.
 * - `ErrorRateLimit` ensures the bot does not spam the group.
 * - `confirmationMessages` are the single-line follow-ups posted after
 *   a user reacts to a proposal (or after a pending one expires).
 */
export const ERROR_MESSAGE = "⚠️ haven ops está com um problema. apanho isto mais tarde, podem registar manualmente no Notion entretanto.";
const THIRTY_MIN_MS = 30 * 60 * 1000;
/**
 * Rate-limits user-facing error notifications. `tryNotify()` returns
 * true at most once every 30 minutes; subsequent calls within the
 * window return false and the caller suppresses the notice.
 */
export class ErrorRateLimit {
    lastNotifiedAt = 0;
    windowMs;
    constructor(windowMs = THIRTY_MIN_MS) {
        this.windowMs = windowMs;
    }
    tryNotify() {
        const now = Date.now();
        if (now - this.lastNotifiedAt >= this.windowMs) {
            this.lastNotifiedAt = now;
            return true;
        }
        return false;
    }
    reset() {
        this.lastNotifiedAt = 0;
    }
}
/**
 * Single-line confirmation strings. Lowercase, no fanfare.
 * Match spec § "After confirm" / "After cancel".
 */
export const confirmationMessages = {
    newTaskAdded(priority) {
        return `✅ adicionado ao backlog (${priority.toLowerCase()})`;
    },
    editApplied() {
        return "✅ atualizado";
    },
    newTaskIgnored() {
        return "❌ ignorado";
    },
    editIgnored() {
        return "❌ deixei como estava";
    },
    pendingExpired() {
        return "esta proposta expirou, fala outra vez";
    },
};
