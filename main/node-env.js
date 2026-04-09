import { execSync } from 'child_process';
import { app } from 'electron';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { createLogger } from './logger.js';

const log = createLogger('node-env');

/** Whether the app is running as a packaged build (not dev mode). */
const isPackaged = app.isPackaged;

/** Whether the app should target local Supabase (set via COURSECODE_LOCAL=1). */
export function isLocalMode() {
    return !!process.env.COURSECODE_LOCAL;
}

/**
 * Get the path to the bundled Node.js binary.
 * In dev mode, uses the system Node. In production, uses Electron's bundled Node.
 */
export function getNodePath() {
    if (!isPackaged) return process.execPath;

    if (process.platform === 'darwin') {
        // In packaged macOS app, Electron's Node is the app binary itself
        return process.execPath;
    }
    // Windows — same pattern
    return process.execPath;
}

/**
 * Get the path to the bundled npm CLI script.
 * In dev mode, uses the system npm. In production, uses the vendored copy.
 */
export function getNpmPath() {
    if (!isPackaged) return 'npm';

    const vendorNpm = join(process.resourcesPath, 'vendor', 'npm', 'bin', 'npm-cli.js');
    if (existsSync(vendorNpm)) return vendorNpm;

    // Fallback: try system npm
    return 'npm';
}

/**
 * Get the path to the bundled npx CLI script.
 */
export function getNpxPath() {
    if (!isPackaged) return 'npx';

    const vendorNpx = join(process.resourcesPath, 'vendor', 'npm', 'bin', 'npx-cli.js');
    if (existsSync(vendorNpx)) return vendorNpx;

    return 'npx';
}

/**
 * Build environment variables for spawning child processes.
 * Prepends the bundled Node directory to PATH so child processes find it.
 */
export function getChildEnv(extraEnv = {}) {
    const nodeDir = dirname(getNodePath());
    const PATH = `${nodeDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`;

    return {
        ...process.env,
        PATH,
        ...extraEnv
    };
}

/**
 * Build spawn arguments for running an npm command.
 * Returns { command, args } suitable for child_process.spawn.
 */
export function npmSpawnArgs(npmArgs) {
    if (!isPackaged) {
        return { command: 'npm', args: npmArgs };
    }

    const npmPath = getNpmPath();
    return {
        command: getNodePath(),
        args: [npmPath, ...npmArgs]
    };
}

/**
 * Kill a child process and all of its descendants (the entire process tree).
 *
 * On Windows, uses `taskkill /T /F` which walks the tree natively.
 * On Unix, kills the process group (requires the child to have been spawned
 * with `detached: true` so it becomes the process group leader).
 * Falls back to a direct `child.kill()` if tree kill fails.
 *
 * Safe to call on an already-dead process (silently no-ops).
 */
export function killProcessTree(child, signal = 'SIGTERM') {
    if (!child || child.killed || child.exitCode !== null) return;

    const pid = child.pid;
    if (!pid) return;

    try {
        if (process.platform === 'win32') {
            // taskkill /T kills the entire process tree; /F forces termination.
            // Windows console processes don't handle SIGTERM, so /F is always used.
            execSync(`taskkill /pid ${pid} /T /F`, {
                windowsHide: true,
                stdio: 'ignore',
                timeout: 5000
            });
        } else {
            // Kill the process group via negative PID.
            // This requires the child to have been spawned with detached: true.
            process.kill(-pid, signal);
        }
    } catch (err) {
        // ESRCH = no such process (already dead). "not found" = taskkill on Windows.
        if (err.code !== 'ESRCH' && !err.message?.includes('not found')) {
            try {
                child.kill(signal);
            } catch (fallbackErr) {
                log.debug('Direct child.kill fallback failed', {
                    pid,
                    signal,
                    error: fallbackErr?.message
                });
            }
        }
    }
}

/**
 * Get the command + args to spawn the `coursecode` CLI.
 * Resolves the CLI bin from node_modules in both dev and production,
 * avoiding Windows .cmd shim issues with spawn().
 * Returns { command, args } — append CLI subcommand args to `args`.
 */
export function getCLISpawnArgs(cliArgs = []) {
    // Resolve CLI from node_modules directly (avoids Windows .cmd shim ENOENT).
    // Dev: __dirname is out/main/, so ../../node_modules
    // Production: __dirname is <app>/main/, so ../node_modules
    const nmBase = isPackaged
        ? join(__dirname, '..', 'node_modules')
        : join(__dirname, '..', '..', 'node_modules');
    const cliBin = join(nmBase, 'coursecode', 'bin', 'cli.js');

    if (existsSync(cliBin)) {
        const nodeCmd = isPackaged ? getNodePath() : 'node';
        return { command: nodeCmd, args: [cliBin, ...cliArgs] };
    }

    // Fallback: assume it's on PATH (e.g. globally installed via Setup Assistant)
    return { command: 'coursecode', args: cliArgs };
}
