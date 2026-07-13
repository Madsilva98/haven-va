/**
 * Shared types for haven-ops bot.
 */
export const RECURRENCE_VALUES = [
    "diária",
    "semanal",
    "mensal",
    "anual",
];
export function isValidRecurrence(value) {
    return (typeof value === "string" &&
        RECURRENCE_VALUES.includes(value));
}
