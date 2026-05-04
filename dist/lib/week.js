/**
 * Week-of-year helpers, all in Europe/Lisbon timezone.
 * Match the Notion `Semana` formula format ("Semana 18").
 */
import { TZDate } from "./tz.js";
export function weekOfYear(date = new Date()) {
    // ISO 8601 week — Monday-based, week containing first Thursday is week 1.
    const local = TZDate.from(date);
    const year = local.getFullYear();
    const month = local.getMonth();
    const day = local.getDate();
    const ms = Date.UTC(year, month, day);
    const target = new Date(ms);
    target.setUTCDate(target.getUTCDate() + 4 - (target.getUTCDay() || 7));
    const yearStart = Date.UTC(target.getUTCFullYear(), 0, 1);
    return Math.ceil(((target.getTime() - yearStart) / 86400000 + 1) / 7);
}
export function currentWeekLabel(date = new Date()) {
    return `Semana ${weekOfYear(date)}`;
}
/**
 * Monday 00:00 Europe/Lisbon for the week containing `date`.
 * Returned as a Date (in Lisbon local fields, but interpreted as UTC).
 */
export function mondayOf(date = new Date()) {
    const local = TZDate.from(date);
    const dayOfWeek = local.getDay() || 7; // Sun=7
    const monday = new Date(local);
    monday.setDate(local.getDate() - (dayOfWeek - 1));
    monday.setHours(0, 0, 0, 0);
    return monday;
}
export function fridayOf(date = new Date()) {
    const monday = mondayOf(date);
    const friday = new Date(monday);
    friday.setDate(monday.getDate() + 4);
    return friday;
}
