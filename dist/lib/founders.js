/**
 * Founder ID resolution.
 *
 * Maps Telegram user IDs ↔ founder names from environment variables.
 * The map is built lazily on first call and cached for the lifetime
 * of the process.
 */
import { log } from "./log.js";
let cache = null;
function parseEnvId(envVar) {
    const raw = process.env[envVar];
    if (!raw)
        return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        log.warn("founders.invalid_env_id", { envVar, raw });
        return null;
    }
    return parsed;
}
function build() {
    const idToName = new Map();
    const nameToId = new Map();
    const entries = [
        ["Madalena", "TELEGRAM_MADALENA_ID"],
        ["Mafalda", "TELEGRAM_MAFALDA_ID"],
        ["Beatriz", "TELEGRAM_BEATRIZ_ID"],
    ];
    for (const [name, envVar] of entries) {
        const id = parseEnvId(envVar);
        if (id === null) {
            log.warn("founders.missing_env", { envVar, name });
            continue;
        }
        idToName.set(id, name);
        nameToId.set(name, id);
    }
    return { idToName, nameToId };
}
function ensure() {
    if (cache === null) {
        cache = build();
    }
    return cache;
}
export function getFounderName(telegramId) {
    return ensure().idToName.get(telegramId) ?? null;
}
export function getTelegramId(name) {
    return ensure().nameToId.get(name) ?? null;
}
export function isFounder(telegramId) {
    return ensure().idToName.has(telegramId);
}
