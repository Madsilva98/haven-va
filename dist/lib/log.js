/**
 * Structured JSON logger. Writes to stdout for Railway to ingest.
 */
function emit(level, msg, data) {
    const entry = {
        ts: new Date().toISOString(),
        level,
        msg,
        ...data,
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(entry));
}
export const log = {
    debug: (msg, data) => process.env.NODE_ENV !== "production" && emit("debug", msg, data),
    info: (msg, data) => emit("info", msg, data),
    warn: (msg, data) => emit("warn", msg, data),
    error: (msg, data) => emit("error", msg, data),
};
