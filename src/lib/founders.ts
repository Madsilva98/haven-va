/**
 * Founder ID resolution.
 *
 * Maps Telegram user IDs ↔ founder names from environment variables.
 * The map is built lazily on first call and cached for the lifetime
 * of the process.
 */

import type { FounderName } from "../types.js";
import { log } from "./log.js";

let cache: {
  idToName: Map<number, FounderName>;
  nameToId: Map<FounderName, number>;
} | null = null;

function parseEnvId(envVar: string): number | null {
  const raw = process.env[envVar];
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    log.warn("founders.invalid_env_id", { envVar, raw });
    return null;
  }
  return parsed;
}

function build(): {
  idToName: Map<number, FounderName>;
  nameToId: Map<FounderName, number>;
} {
  const idToName = new Map<number, FounderName>();
  const nameToId = new Map<FounderName, number>();

  const entries: Array<[FounderName, string]> = [
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

function ensure(): {
  idToName: Map<number, FounderName>;
  nameToId: Map<FounderName, number>;
} {
  if (cache === null) {
    cache = build();
  }
  return cache;
}

export function getFounderName(telegramId: number): FounderName | null {
  return ensure().idToName.get(telegramId) ?? null;
}

export function getTelegramId(name: FounderName): number | null {
  return ensure().nameToId.get(name) ?? null;
}

export function isFounder(telegramId: number): boolean {
  return ensure().idToName.has(telegramId);
}
