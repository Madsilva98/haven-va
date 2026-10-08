/**
 * Read-only access to the haven-comms repo on GitHub, for the Monday
 * competitor-movements message. haven-comms' weekly workflow writes the
 * week's competitor breaks into research/competitors/monthly/<YYYY-MM>/watch.json
 * (the same file haven-studio loads onto the dashboard's Competitors page)
 * and a run status into research/competitors/movements/<date>/status.json.
 *
 * Needs COMMS_READ_TOKEN: a fine-grained GitHub token, contents read-only on
 * haven-comms — same pattern as haven-studio's scripts/load-competitor-watch.mjs.
 * Without it the caller no-ops.
 */
const REPO = "Madsilva98/haven-comms";
const BRANCH = "main";
export function commsReadEnabled() {
    return Boolean(process.env.COMMS_READ_TOKEN);
}
async function contents(path, raw) {
    const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}?ref=${BRANCH}`, {
        headers: {
            Authorization: `Bearer ${process.env.COMMS_READ_TOKEN}`,
            Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    });
    if (res.status === 404)
        return null;
    if (!res.ok)
        throw new Error(`GitHub ${path}: HTTP ${res.status}`);
    return raw ? JSON.parse(await res.text()) : res.json();
}
/** The month's innovations, or [] when that month has no watch.json yet. */
export async function fetchInnovations(month) {
    const watch = (await contents(`research/competitors/monthly/${month}/watch.json`, true));
    return watch?.innovations ?? [];
}
/** status.json of the newest movements run, or null if there has never been one. */
export async function fetchLatestMovementsStatus() {
    const listing = (await contents("research/competitors/movements", false));
    const dates = (listing ?? [])
        .filter((e) => e.type === "dir" && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
        .map((e) => e.name)
        .sort();
    const latest = dates[dates.length - 1];
    if (!latest)
        return null;
    return (await contents(`research/competitors/movements/${latest}/status.json`, true));
}
