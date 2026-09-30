/**
 * Shared "this batch is too big to be real" check for crons that archive
 * Notion rows on their own (failsafe-audit-2026-09-29.md). When a single run
 * would archive an implausible share of a list, it's far more likely bad
 * input data (a Kenko import glitch, a view regression — the 2026-09-16
 * Intro Pack mass-archive) than a real week, so the caller archives nothing
 * and tells the founders instead.
 *
 * Each cron picks its own bar, set by the founder:
 *   - leads-reconcile: 30% (re-doing the leads list by hand is real work)
 *   - churn-risk: 70% (a short list, where over half legitimately changing
 *     in one week is normal — but losing the founder's notes is not OK)
 * `minRows` keeps a tiny list (e.g. 2 of 3) from tripping it every week.
 */
export function isSuspiciousBatch(wouldArchive, total, opts) {
    if (total === 0)
        return false;
    return wouldArchive >= opts.minRows && wouldArchive / total > opts.share;
}
