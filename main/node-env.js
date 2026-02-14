import { app } from 'electron';
import { join, dirname } from 'path';
import { existsSync } from 'fs';

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
 * Get the command + args to spawn the `coursecode` CLI.
 * In dev mode, `coursecode` is globally installed and on PATH.
 * In production, resolve from the bundled node_modules dependency.
 * Returns { command, args } — append CLI subcommand args to `args`.
 */
export function getCLISpawnArgs(cliArgs = []) {
    if (!isPackaged) {
        return { command: 'coursecode', args: cliArgs };
    }

    // Production: resolve CLI from bundled node_modules
    // We can't use require.resolve for the bin file (blocked by exports map),
    // but the file is on disk — just construct the path directly.
    const cliBin = join(__dirname, '..', 'node_modules', 'coursecode', 'bin', 'cli.js');
    if (existsSync(cliBin)) {
        return { command: getNodePath(), args: [cliBin, ...cliArgs] };
    }

    // Fallback: assume it's on PATH (e.g. globally installed via Setup Assistant)
    return { command: 'coursecode', args: cliArgs };
}
