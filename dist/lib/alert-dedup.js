/**
 * In-process dedup key helpers for pipeline-alerts.ts.
 *
 * Partner/influencer alerts dedup per week (a number); content-calendar
 * scheduling alerts dedup per calendar day (a "YYYY-MM-DD" string) since
 * it's a short 2-day lookahead, not a weekly cadence. Both are just the
 * key's last segment, so `pruneStaleKeys` compares it as a string against
 * both the current week and today's date.
 */
export function alertKey(rowId, type, scope) {
    return `${rowId}|${type}|${scope}`;
}
export function pruneStaleKeys(keys, currentWeek, today) {
    const stale = [];
    for (const key of keys) {
        const scope = key.split("|").at(-1);
        if (scope !== String(currentWeek) && scope !== today) {
            stale.push(key);
        }
    }
    return stale;
}
