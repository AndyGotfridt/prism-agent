import { appendFileSync, copyFileSync, statSync, truncateSync } from 'node:fs';
import { format } from 'node:util';

/**
 * Service log, in English:
 *
 *   2026-10-09 02:54:05 INFO  Uploading Lunara_Base.gcode.3mf
 *   2026-10-09 02:54:13 WARN  Lunara_Base.gcode.3mf: HTTP 502, retry 1/4 in 1s
 *
 * Local time, one line per event. Never log the token. What the user reads (terminal output
 * of `status`, `login`…, the popup and notifications) stays in Spanish.
 *
 * Where it goes: stdout by default (the terminal, or the file launchd redirects it to on
 * macOS). With PRISMA_AGENT_LOG_FILE (the Windows launcher sets it) the agent appends to
 * that file itself: `cmd >>` doesn't append after someone else truncates the file, so the
 * log could not be rotated.
 */
const FILE = process.env.PRISMA_AGENT_LOG_FILE || null;

/** Rotate once the log reaches this size: the current one goes to `<log>.1` (one copy kept). */
export const LOG_MAX_BYTES = 5 * 1024 * 1024;

const pad = (n) => String(n).padStart(2, '0');

function stamp() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function write(level, args, fallback) {
    const line = `${stamp()} ${level} ${format(...args)}`;
    if (FILE) {
        try {
            appendFileSync(FILE, line + '\n');
            return;
        } catch {
            // Without the file, at least stdout.
        }
    }
    fallback(line);
}

export function log(...args) {
    write('INFO ', args, console.log);
}

export function warn(...args) {
    write('WARN ', args, console.warn);
}

export function error(...args) {
    write('ERROR', args, console.error);
}

/** The file this process logs to, if it's a service (null in a terminal: nothing to rotate). */
export function ownLogFile() {
    return FILE;
}

/**
 * Copy + truncate (not rename): on macOS launchd keeps the file open with O_APPEND, so after
 * truncating it writes from the start again. A rename would leave it writing into `.1`.
 * Returns true if it rotated.
 */
export function rotateLog(path, maxBytes = LOG_MAX_BYTES) {
    try {
        if (statSync(path).size < maxBytes) return false;
        copyFileSync(path, `${path}.1`);
        truncateSync(path, 0);
        return true;
    } catch {
        return false; // no log yet, or no permission: try again next time
    }
}

if (FILE) {
    // No stderr redirect behind us: an unexpected crash has to land in the log too.
    process.on('uncaughtException', (err) => {
        error(`Crashed: ${err?.stack ?? err}`);
        process.exit(1);
    });
}
