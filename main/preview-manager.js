import { spawn } from 'child_process';
import { shell } from 'electron';
import { getChildEnv, getCLISpawnArgs, killProcessTree } from './node-env.js';
import { stopMcpClient, killAllMcpClients } from './mcp-client.js';
import { createLogger } from './logger.js';
import { getSetting, saveSetting } from './settings.js';

const log = createLogger('preview');
const PREVIEW_PORTS_KEY = 'previewPorts';

/** Map of projectPath → { process, port } */
const previews = new Map();

function getPreviewPorts() {
    const value = getSetting(PREVIEW_PORTS_KEY);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    return {};
}

function savePreviewPort(projectPath, port) {
    const ports = getPreviewPorts();
    ports[projectPath] = port;
    saveSetting(PREVIEW_PORTS_KEY, ports);
}

function isValidPort(value) {
    return Number.isInteger(value) && value > 0 && value <= 65535;
}

function isPortReservedByOtherProject(projectPath, port) {
    const ports = getPreviewPorts();
    for (const [path, assigned] of Object.entries(ports)) {
        if (path !== projectPath && assigned === port) return true;
    }
    return false;
}

function isPortUsedByRunningPreview(projectPath, port) {
    for (const [path, entry] of previews) {
        if (path !== projectPath && !entry.process.killed && entry.port === port) return true;
    }
    return false;
}

/**
 * Find a free port by asking the OS.
 */
async function findFreePort() {
    const { createServer } = await import('net');
    return new Promise((resolve, reject) => {
        const srv = createServer();
        srv.listen(0, () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
        srv.on('error', reject);
    });
}

/**
 * Check whether a specific port can be bound now.
 */
async function isPortAvailable(port) {
    const { createServer } = await import('net');
    return new Promise((resolve) => {
        const srv = createServer();
        srv.once('error', () => resolve(false));
        srv.listen(port, '127.0.0.1', () => {
            srv.close(() => resolve(true));
        });
    });
}

async function resolvePreviewPort(projectPath) {
    const ports = getPreviewPorts();
    const assigned = ports[projectPath];

    if (isValidPort(assigned)) {
        const reservedElsewhere = isPortReservedByOtherProject(projectPath, assigned);
        const usedByPreview = isPortUsedByRunningPreview(projectPath, assigned);
        const available = !reservedElsewhere && !usedByPreview && await isPortAvailable(assigned);

        if (available) return assigned;

        log.info('Assigned preview port unavailable, selecting new port', {
            projectPath,
            assigned,
            reservedElsewhere,
            usedByPreview
        });
    }

    for (let i = 0; i < 20; i++) {
        const candidate = await findFreePort();
        if (isPortReservedByOtherProject(projectPath, candidate)) continue;
        if (isPortUsedByRunningPreview(projectPath, candidate)) continue;
        savePreviewPort(projectPath, candidate);
        return candidate;
    }

    throw new Error('Failed to allocate preview port');
}

/**
 * Wait for a URL to become reachable.
 */
async function waitForServer(url, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const resp = await fetch(url);
            if (resp.ok) return true;
        } catch (err) { log.debug('Waiting for server...', { url, err: err.message }); }
        await new Promise(r => setTimeout(r, 500));
    }
    throw new Error(`Server at ${url} did not start within ${timeoutMs}ms`);
}

/**
 * Start a preview server for a project.
 * Returns { port } when the server is ready.
 */
export async function startPreview(projectPath, webContents, { openBrowser = true } = {}) {
    // If already running or starting, wait for it
    if (previews.has(projectPath)) {
        const existing = previews.get(projectPath);
        if (!existing.process.killed) {
            log.debug(`Joining existing server for ${projectPath}`);
            try {
                await existing.ready; // Wait for the original startup to finish
                return { port: existing.port };
            } catch (err) {
                log.warn('Existing server failed to start, retrying...', err);
                previews.delete(projectPath);
                // Fall through to start new
            }
        } else {
            previews.delete(projectPath);
        }
    }

    const port = await resolvePreviewPort(projectPath);
    const env = getChildEnv({ PORT: String(port) });

    // Spawn the coursecode CLI preview command
    const { command, args } = getCLISpawnArgs(['preview', '--port', String(port), '--desktop']);
    log.info(`Spawning: ${command} ${args.join(' ')}`, { projectPath, port });
    const child = spawn(command, args, {
        cwd: projectPath,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // On Unix, make the child a process group leader so killProcessTree
        // can kill the entire tree via negative PID.
        ...(process.platform !== 'win32' ? { detached: true } : {})
    });

    child.on('error', (err) => {
        log.error(`Failed to spawn preview server for ${projectPath}`, err);
        previews.delete(projectPath);
        if (webContents && !webContents.isDestroyed()) {
            webContents.send('preview:log', { projectPath, type: 'stderr', text: `Failed to start: ${err.message}` });
        }
    });

    // Track whether the initial build has completed so we don't resolve
    // readiness before the file watcher's first rebuild finishes (which
    // would cause the preview iframe to load, then immediately reload
    // when live-reload fires after the build).
    let sawBuilding = false;
    let buildComplete = false;
    let resolveBuildReady;
    const buildReadyPromise = new Promise((resolve) => { resolveBuildReady = resolve; });

    // Stream stdout/stderr to renderer
    child.stdout.on('data', (data) => {
        const text = data.toString();
        log.debug('stdout', { text: text.trim() });

        // Detect the initial build cycle so we can wait for it
        if (!buildComplete && text.includes('Building')) {
            sawBuilding = true;
        }
        if (sawBuilding && !buildComplete && text.includes('Build complete')) {
            buildComplete = true;
            resolveBuildReady();
        }

        if (webContents && !webContents.isDestroyed()) {
            webContents.send('preview:log', { projectPath, type: 'stdout', text });
        }
    });

    child.stderr.on('data', (data) => {
        log.debug('stderr', { text: data.toString().trim() });
        if (webContents && !webContents.isDestroyed()) {
            webContents.send('preview:log', { projectPath, type: 'stderr', text: data.toString() });
        }
    });

    child.on('exit', (code) => {
        log.info(`Exited with code: ${code}`, { projectPath });
        previews.delete(projectPath);
        // Unblock build wait if the process exits before build completes
        if (!buildComplete) resolveBuildReady();
        if (webContents && !webContents.isDestroyed()) {
            webContents.send('preview:log', { projectPath, type: 'exit', code });
        }
    });

    // Create a deferred promise for readiness
    let resolveReady, rejectReady;
    const readyPromise = new Promise((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
    });

    // Store immediately so subsequent calls find it
    previews.set(projectPath, { process: child, port, ready: readyPromise });

    // Wait for HTTP server to respond, then wait for the initial build
    // to finish so the iframe loads the fully-built content and doesn't
    // get reloaded by the live-reload triggered by the initial rebuild.
    try {
        await waitForServer(`http://127.0.0.1:${port}`);
        // Wait up to 30s for the initial build, but don't block forever
        // if the server doesn't trigger a build (e.g. no file changes).
        await Promise.race([
            buildReadyPromise,
            new Promise(r => setTimeout(r, 30000))
        ]);
        resolveReady();
        if (openBrowser) shell.openExternal(`http://127.0.0.1:${port}`);
    } catch (e) {
        log.error('Server startup failed', e);
        rejectReady(e);
        // We don't delete here immediately to let the caller handle the error, 
        // but the process exit handler will clean up map.
        // If the process is still running but unresponsive, kill the entire tree:
        killProcessTree(child, 'SIGKILL');
    }

    return { port };
}

/**
 * Stop a running preview server.
 */
export async function stopPreview(projectPath) {
    // Stop the MCP client first (it depends on the preview server)
    stopMcpClient(projectPath);

    const entry = previews.get(projectPath);
    if (!entry) return;

    // Wait for the process to actually exit so file handles are released
    await new Promise((resolve) => {
        const onExit = () => {
            clearTimeout(killTimer);
            resolve();
        };

        // If already dead, resolve immediately
        if (entry.process.killed || entry.process.exitCode !== null) {
            resolve();
            return;
        }

        entry.process.once('exit', onExit);
        killProcessTree(entry.process, 'SIGTERM');

        // Force kill the entire tree after 5s, then resolve regardless
        const killTimer = setTimeout(() => {
            killProcessTree(entry.process, 'SIGKILL');
            resolve();
        }, 5000);
    });

    previews.delete(projectPath);
}

/**
 * Get preview status for a project.
 */
export function getPreviewStatus(projectPath) {
    const entry = previews.get(projectPath);
    if (!entry || entry.process.killed) return 'stopped';
    return 'running';
}

/**
 * Get preview port for a project (null if not running).
 */
export function getPreviewPort(projectPath) {
    const entry = previews.get(projectPath);
    if (!entry || entry.process.killed) return null;
    return entry.port;
}

/**
 * Reverse-lookup: given a preview port, return the project path that owns it.
 * Returns null if no running preview matches.
 */
export function getProjectForPort(port) {
    for (const [projectPath, entry] of previews) {
        if (!entry.process.killed && entry.port === port) return projectPath;
    }
    return null;
}

/**
 * Get status + port for all tracked projects.
 * Returns { [projectPath]: { status, port } }
 */
export function getAllPreviewStatuses() {
    const result = {};
    for (const [path, entry] of previews) {
        const alive = !entry.process.killed;
        result[path] = {
            status: alive ? 'running' : 'stopped',
            port: alive ? entry.port : null
        };
    }
    return result;
}

/**
 * Kill all running preview servers (called on app quit).
 */
export function killAllPreviews() {
    killAllMcpClients();
    for (const [, entry] of previews) {
        try {
            // During quit the event loop is tearing down, so setTimeout-based
            // fallbacks will never fire. Use synchronous SIGKILL on the entire
            // process tree to guarantee no orphans survive.
            killProcessTree(entry.process, 'SIGKILL');
        } catch (e) {
            log.warn('Error killing preview process tree', e);
        }
    }
    previews.clear();
}
