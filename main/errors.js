import { createLogger } from './logger.js';

const log = createLogger('ipc');

// --- Error translation table ---

const ERROR_MAP = [
    { match: (e) => e.code === 'EADDRINUSE', code: 'PORT_IN_USE', message: 'Another app is using that port. Try stopping other preview servers first.' },
    { match: (e) => e.code === 'EACCES', code: 'PERMISSION_DENIED', message: 'Permission denied. Try moving your project to a different folder.' },
    { match: (e) => e.code === 'ENOENT', code: 'FILE_MISSING', message: 'A required file is missing. The project may be incomplete.' },
    { match: (e) => e.code === 'ECONNREFUSED' || e.cause?.code === 'ECONNREFUSED', code: 'NETWORK_ERROR', message: "Couldn't reach the server. Check your internet connection." },
    { match: (e) => e.message?.includes('npm ERR!'), code: 'NPM_ERROR', message: 'Something went wrong installing dependencies. Click "Retry" to try again.' },
    { match: (e) => e.status === 401, code: 'AUTH_EXPIRED', message: 'Your session has expired. Sign in again.' },
    { match: (e) => e.status === 402, code: 'NO_CREDITS', message: "You're out of credits. Top up at coursecodecloud.com" },
    { match: (e) => e.status === 429, code: 'RATE_LIMITED', message: 'The service is busy. Try again in a moment.' },
    { match: (e) => e.code === 'CLI_NOT_READY', code: 'CLI_NOT_READY', message: 'CourseCode tools are not installed or not working yet. Open Setup Assistant to install or repair them.' },
    { match: (e) => e.message?.includes('safeStorage') || e.message?.includes('encryption'), code: 'ENCRYPTION_UNAVAILABLE', message: 'System encryption is not available. Cannot securely store API key.' },
    { match: (e) => e.message?.includes('fetch') && (e.cause?.code === 'ENOTFOUND' || e.cause?.code === 'ETIMEDOUT'), code: 'NETWORK_ERROR', message: "Couldn't reach the server. Check your internet connection." },
    { match: (e) => e.message?.includes('fetch failed') || e.message?.includes('timed out'), code: 'NETWORK_ERROR', message: "Couldn't reach the AI service. If using local mode, check that the cloud app is running." },
];

/**
 * Translate a raw error into a user-friendly error object.
 *
 * @param {Error} err — the raw error
 * @returns {{ message: string, detail: string, code: string }}
 */
export function translateError(err) {
    if (!err) return { message: 'An unknown error occurred.', detail: '', code: 'INTERNAL' };

    for (const entry of ERROR_MAP) {
        if (entry.match(err)) {
            return {
                message: entry.message,
                detail: err.message || '',
                code: entry.code,
            };
        }
    }

    return {
        message: `Something went wrong: ${err.message || 'Unknown error'}`,
        detail: err.stack || err.message || '',
        code: 'INTERNAL',
    };
}

/**
 * Translate a raw error into a chat-specific user-friendly message.
 * Handles cloud vs BYOK context for auth errors.
 *
 * @param {Error} err
 * @param {boolean} isCloud — whether the error occurred in cloud mode
 * @returns {string}
 */
export function translateChatError(err, isCloud) {
    if (err.status === 401) {
        return isCloud
            ? "Your cloud session has expired. Sign in again from the Dashboard."
            : "Your API key doesn't seem to be working. Check Settings → AI.";
    }

    const translated = translateError(err);
    return translated.message;
}

/**
 * Wrap an IPC handler function with automatic error logging and translation.
 * Catches all errors (sync and async), logs them, and re-throws a serializable error.
 *
 * Usage:
 *   ipcMain.handle('preview:start', wrapIpcHandler('preview:start', (e, path, opts) => startPreview(path, e.sender, opts)));
 *
 * @param {string} channel — the IPC channel name (for logging)
 * @param {Function} fn — the handler function
 * @returns {Function} — wrapped handler
 */
export function wrapIpcHandler(channel, fn) {
    return async (...args) => {
        try {
            return await fn(...args);
        } catch (err) {
            log.error(`IPC ${channel} failed`, err);
            const translated = translateError(err);
            // Re-throw a clean, serializable error for the renderer
            const cleanError = new Error(translated.message);
            cleanError.code = translated.code;
            cleanError.detail = translated.detail;
            throw cleanError;
        }
    };
}
