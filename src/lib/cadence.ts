/**
 * Per-founder notification cadence. Driven by env var `FOUNDER_CADENCE`
 * which is JSON like:
 *   {"Madalena":"daily","Mafalda":"weekly","Beatriz":"weekly"}
 *
 * Default if missing or unparseable: everyone is "weekly".
 */

import type { FounderName } from "../types.js";
import { log } from "./log.js";

export type Cadence = "daily" | "weekly";

let cache: Record<FounderName, Cadence> | null = null;

function build(): Record<FounderName, Cadence> {
  const defaults: Record<FounderName, Cadence> = {
    Madalena: "weekly",
    Mafalda: "weekly",
    Beatriz: "weekly",
  };

  const raw = process.env.FOUNDER_CADENCE;
  if (!raw) return defaults;

  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    for (const founder of ["Madalena", "Mafalda", "Beatriz"] as const) {
      const value = parsed[founder];
      if (value === "daily" || value === "weekly") {
        defaults[founder] = value;
      }
    }
    return defaults;
  } catch (err) {
    log.warn("cadence.invalid_json", { err: String(err), raw });
    return defaults;
  }
}

export function getCadence(founder: FounderName): Cadence {
  if (!cache) cache = build();
  return cache[founder];
}

export function foundersOnCadence(target: Cadence): FounderName[] {
  if (!cache) cache = build();
  return (Object.entries(cache) as Array<[FounderName, Cadence]>)
    .filter(([, c]) => c === target)
    .map(([f]) => f);
}
