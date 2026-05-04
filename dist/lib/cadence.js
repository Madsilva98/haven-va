/**
 * Per-founder notification cadence. Driven by env var `FOUNDER_CADENCE`
 * which is JSON like:
 *   {"Madalena":"daily","Mafalda":"weekly","Beatriz":"weekly"}
 *
 * Default if missing or unparseable: everyone is "weekly".
 */
import { log } from "./log.js";
let cache = null;
function build() {
    const defaults = {
        Madalena: "weekly",
        Mafalda: "weekly",
        Beatriz: "weekly",
    };
    const raw = process.env.FOUNDER_CADENCE;
    if (!raw)
        return defaults;
    try {
        const parsed = JSON.parse(raw);
        for (const founder of ["Madalena", "Mafalda", "Beatriz"]) {
            const value = parsed[founder];
            if (value === "daily" || value === "weekly") {
                defaults[founder] = value;
            }
        }
        return defaults;
    }
    catch (err) {
        log.warn("cadence.invalid_json", { err: String(err), raw });
        return defaults;
    }
}
export function getCadence(founder) {
    if (!cache)
        cache = build();
    return cache[founder];
}
export function foundersOnCadence(target) {
    if (!cache)
        cache = build();
    return Object.entries(cache)
        .filter(([, c]) => c === target)
        .map(([f]) => f);
}
