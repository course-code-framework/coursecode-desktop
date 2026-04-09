import { app } from 'electron';
import { join, dirname } from 'path';
import { writeFileSync, renameSync, statSync, mkdirSync, existsSync, appendFileSync } from 'fs';

// --- Configuration ---

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_ROTATED = 3;
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const isDev = !app.isPackaged;
const devFileLoggingEnabled = isDev && !/^(0|false|no)$/i.test(String(process.env.COURSECODE_DEV_FILE_LOGS || ''));

// --- ANSI colors for dev console ---

const COLORS = {
    debug: '\x1b[90m',   // grey
    info: '\x1b[36m',    // cyan
    warn: '\x1b[33m',    // yellow
    error: '\x1b[31m',   // red
    reset: '\x1b[0m',
    dim: '\x1b[2m',
    bold: '\x1b[1m',
};

// --- File logging (production only) ---

let logFilePath = null;
let logDirReady = false;

function getLogDir() {
    return join(app.getPath('userData'), 'logs');
}

function getLogFilePath() {
    if (!logFilePath) {
        logFilePath = join(getLogDir(), devFileLoggingEnabled ? 'dev-main.log' : 'main.log');
    }
    return logFilePath;
}

function ensureLogDir() {
    if (logDirReady) return;
    const dir = getLogDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    logDirReady = true;
}

function rotateIfNeeded() {
    const filePath = getLogFilePath();
    if (!existsSync(filePath)) return;

    try {
        const size = statSync(filePath).size;
        if (size < MAX_FILE_SIZE) return;

        // Shift existing rotated files: main.3.log → deleted, main.2.log → main.3.log, etc.
        for (let i = MAX_ROTATED; i >= 1; i--) {
            const from = i === 1 ? filePath : `${filePath}.${i - 1}`;
            const to = `${filePath}.${i}`;
            if (existsSync(from)) {
                try { renameSync(from, to); } catch { /* best effort */ }
            }
        }
    } catch {
        // Can't stat — file may have been deleted, that's fine
    }
}

function writeToFile(jsonLine) {
    try {
        ensureLogDir();
        appendFileSync(getLogFilePath(), jsonLine + '\n');
    } catch {
        // Last resort — if we can't write to the log file, we truly can't do anything.
        // Swallowing here is the ONLY acceptable silent failure in the entire app:
        // logging infrastructure itself cannot infinitely recurse on its own errors.
    }
}

// --- Rotate on startup (production only) ---

let startupRotationDone = false;

function rotateOnStartup() {
    if (startupRotationDone || (isDev && !devFileLoggingEnabled)) return;
    startupRotationDone = true;
    rotateIfNeeded();
}

// --- Console formatters ---

function devConsole(level, module, message, extra) {
    const time = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    const color = COLORS[level] || COLORS.reset;
    const prefix = `${COLORS.dim}${time}${COLORS.reset} ${color}${level.toUpperCase().padEnd(5)}${COLORS.reset} ${COLORS.bold}[${module}]${COLORS.reset}`;

    if (extra instanceof Error) {
        console.log(`${prefix} ${message}`);
        console.log(`${COLORS.dim}${extra.stack || extra.message}${COLORS.reset}`);
    } else if (extra !== undefined) {
        console.log(`${prefix} ${message}`, extra);
    } else {
        console.log(`${prefix} ${message}`);
    }
}

function prodConsole(level, module, message, extra) {
    const time = new Date().toISOString().slice(11, 23);
    const prefix = `${time} ${level.toUpperCase().padEnd(5)} [${module}]`;

    if (extra instanceof Error) {
        console.log(`${prefix} ${message}: ${extra.message}`);
    } else if (extra !== undefined) {
        console.log(`${prefix} ${message}`, extra);
    } else {
        console.log(`${prefix} ${message}`);
    }
}

function fileWrite(level, module, message, extra) {
    rotateOnStartup();

    const entry = {
        t: new Date().toISOString(),
        l: level,
        m: module,
        msg: message,
    };

    if (extra instanceof Error) {
        entry.err = extra.message;
        entry.stack = extra.stack;
    } else if (extra !== undefined) {
        entry.data = extra;
    }

    writeToFile(JSON.stringify(entry));
}

// --- Logger factory ---

/**
 * Create a scoped logger for a module.
 *
 * @param {string} module — short module name, e.g. 'preview', 'chat', 'cloud'
 * @returns {{ debug, info, warn, error }}
 *
 * Usage:
 *   const log = createLogger('preview');
 *   log.debug('Polling server', { port });   // dev console only
 *   log.info('Server ready', { port });      // always
 *   log.warn('Slow startup', { elapsed });   // always
 *   log.error('Failed to start', err);       // always, stack in file
 */
export function createLogger(module) {
    function emit(level, message, extra) {
        const levelValue = LEVELS[level];

        if (isDev) {
            // Dev: all levels to console. Optional file logging when enabled via env.
            devConsole(level, module, message, extra);
            if (devFileLoggingEnabled) {
                fileWrite(level, module, message, extra);
            }
        } else {
            // Prod: warn+ to console, all levels to file
            if (levelValue >= LEVELS.warn) {
                prodConsole(level, module, message, extra);
            }
            fileWrite(level, module, message, extra);
        }
    }

    return {
        debug: (message, extra) => emit('debug', message, extra),
        info: (message, extra) => emit('info', message, extra),
        warn: (message, extra) => emit('warn', message, extra),
        error: (message, extra) => emit('error', message, extra),
    };
}
