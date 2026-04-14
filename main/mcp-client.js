import { spawn } from 'child_process';
import { app } from 'electron';
import { getCLISpawnArgs, getChildEnv, killProcessTree } from './node-env.js';
import { getPreviewPort } from './preview-manager.js';
import { createLogger } from './logger.js';

const log = createLogger('mcp');

/**
 * MCP Client — communicates with `coursecode mcp` over stdio using JSON-RPC 2.0.
 * One MCP process per project, tied to the preview server's port.
 */

/** Map of projectPath → McpConnection */
const connections = new Map();

/** Auto-incrementing JSON-RPC request ID */
let nextRequestId = 1;

/** Health check interval (ms) */
const HEALTH_CHECK_INTERVAL = 30000;

/** Tool-specific timeouts (ms) */
const TOOL_TIMEOUTS = {
    coursecode_build:    120000,
    coursecode_state:    15000,
    coursecode_screenshot: 20000,
};
const DEFAULT_TOOL_TIMEOUT = 60000;

/** Maximum auto-reconnection attempts before giving up */
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 1000;

class McpConnection {
    constructor(process, projectPath) {
        this.process = process;
        this.projectPath = projectPath;
        this.pending = new Map();    // id → { resolve, reject, timer }
        this.buffer = '';
        this.initialized = false;
        this.initPromise = null;
        this._healthTimer = null;
        this._dead = false;
        this._serverInstructions = null;

        // Parse newline-delimited JSON from stdout
        process.stdout.on('data', (chunk) => {
            this.buffer += chunk.toString();
            this._processBuffer();
        });

        process.stderr.on('data', (chunk) => {
            log.debug('stderr', { text: chunk.toString().trim() });
        });

        process.on('exit', (code) => {
            log.info('Process exited', { code });
            this._stopHealthCheck();
            // Reject all pending requests
            for (const [id, entry] of this.pending) {
                clearTimeout(entry.timer);
                entry.reject(new Error(`MCP process exited (code ${code})`));
            }
            this.pending.clear();
        });
    }

    _startHealthCheck() {
        this._stopHealthCheck();
        this._healthTimer = setInterval(async () => {
            try {
                await this.request('ping', {}, 5000);
            } catch {
                log.warn('Health check failed', { projectPath: this.projectPath });
                this._dead = true;
                this._stopHealthCheck();
            }
        }, HEALTH_CHECK_INTERVAL);
    }

    _stopHealthCheck() {
        if (this._healthTimer) {
            clearInterval(this._healthTimer);
            this._healthTimer = null;
        }
    }

    get isAlive() {
        return !this._dead && !this.process.killed && this.process.exitCode == null;
    }

    _processBuffer() {
        // MCP uses newline-delimited JSON-RPC messages
        let newlineIdx;
        while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, newlineIdx).trim();
            this.buffer = this.buffer.slice(newlineIdx + 1);
            if (!line) continue;

            try {
                const msg = JSON.parse(line);
                this._handleMessage(msg);
            } catch (err) {
                log.warn('Failed to parse message', { line, err: err.message });
            }
        }
    }

    _handleMessage(msg) {
        // JSON-RPC response (has id)
        if (msg.id != null && this.pending.has(msg.id)) {
            const entry = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            clearTimeout(entry.timer);

            if (msg.error) {
                entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            } else {
                entry.resolve(msg.result);
            }
        }
        // Notifications (no id) — log but don't need to handle
    }

    /**
     * Send a JSON-RPC request and wait for the response.
     */
    request(method, params = {}, timeoutMs = 60000) {
        return new Promise((resolve, reject) => {
            if (this.process.killed || this.process.exitCode != null) {
                return reject(new Error('MCP process is not running'));
            }

            const id = nextRequestId++;
            const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';

            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`MCP request timed out: ${method}`));
            }, timeoutMs);

            this.pending.set(id, { resolve, reject, timer });

            try {
                this.process.stdin.write(msg);
            } catch (err) {
                this.pending.delete(id);
                clearTimeout(timer);
                reject(err);
            }
        });
    }

    /**
     * Send a JSON-RPC notification (no response expected).
     */
    notify(method, params = {}) {
        if (this.process.killed || this.process.exitCode != null) return;
        const msg = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
        try {
            this.process.stdin.write(msg);
        } catch (err) { log.debug('Notify write failed', err); }
    }

    /**
     * Run the MCP initialize handshake.
     */
    async initialize() {
        if (this.initialized) return;
        if (this.initPromise) return this.initPromise;

        this.initPromise = (async () => {
            const result = await this.request('initialize', {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'coursecode-desktop', version: app.getVersion() }
            });
            this.notify('notifications/initialized');
            this.initialized = true;
            this._serverInstructions = result?.instructions || null;
            this._startHealthCheck();
            return result;
        })();

        return this.initPromise;
    }

    /**
     * Call an MCP tool and return the result.
     * Uses tool-specific timeouts for builds vs reads.
     */
    async callTool(name, args = {}) {
        await this.initialize();
        const timeout = TOOL_TIMEOUTS[name] || DEFAULT_TOOL_TIMEOUT;
        const result = await this.request('tools/call', { name, arguments: args }, timeout);
        return result;
    }

    /**
     * List available MCP tools for the active project/session.
     */
    async listTools() {
        await this.initialize();
        const result = await this.request('tools/list', {});
        return Array.isArray(result?.tools) ? result.tools : [];
    }

    kill() {
        this._stopHealthCheck();
        this._dead = true;
        killProcessTree(this.process, 'SIGTERM');
        this._killTimer = setTimeout(() => {
            killProcessTree(this.process, 'SIGKILL');
        }, 3000);
    }

    /**
     * Immediately force-kill the process tree. Used during app quit
     * when the event loop is tearing down and setTimeout won't fire.
     */
    forceKill() {
        this._stopHealthCheck();
        this._dead = true;
        clearTimeout(this._killTimer);
        killProcessTree(this.process, 'SIGKILL');
    }
}

/**
 * Get or create an MCP connection for a project.
 * Requires the preview server to be running (needs its port).
 */
export async function getMcpClient(projectPath) {
    // Return existing live connection
    const existing = connections.get(projectPath);
    if (existing?.isAlive) {
        return existing;
    }

    // Clean up dead connection if present
    if (existing) {
        log.info('Replacing dead MCP connection', { projectPath });
        try { existing.kill(); } catch { /* already dead */ }
        connections.delete(projectPath);
    }

    // Need preview port
    const port = getPreviewPort(projectPath);
    if (!port) {
        throw new Error('Preview server is not running. Cannot start MCP client.');
    }

    // Spawn with retry logic
    let lastError;
    for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
        try {
            const conn = await _spawnMcpConnection(projectPath, port);
            return conn;
        } catch (err) {
            lastError = err;
            log.warn(`MCP connection attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS} failed`, {
                projectPath, error: err?.message
            });
            if (attempt < MAX_RECONNECT_ATTEMPTS) {
                await new Promise(r => setTimeout(r, RECONNECT_DELAY_MS * attempt));
            }
        }
    }

    throw lastError || new Error('Failed to connect to MCP server');
}

async function _spawnMcpConnection(projectPath, port) {
    const { command, args } = getCLISpawnArgs(['mcp', '--port', String(port)]);
    const env = getChildEnv();

    log.info(`Spawning: ${command} ${args.join(' ')}`, { projectPath });
    const child = spawn(command, args, {
        cwd: projectPath,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // On Unix, make the child a process group leader so killProcessTree
        // can kill the entire tree via negative PID.
        ...(process.platform !== 'win32' ? { detached: true } : {})
    });

    const conn = new McpConnection(child, projectPath);
    connections.set(projectPath, conn);

    // Clean up on exit
    child.on('exit', () => {
        if (connections.get(projectPath) === conn) {
            connections.delete(projectPath);
        }
    });

    // Wait for initialize handshake
    await conn.initialize();
    log.info('Connected', { projectPath });

    return conn;
}

/**
 * Return the tool definitions advertised by the MCP server for this project.
 * Returns an empty array if discovery fails.
 */
export async function getMcpTools(projectPath) {
    try {
        const conn = await getMcpClient(projectPath);
        return await conn.listTools();
    } catch (err) {
        log.debug('Failed to discover MCP tools', { projectPath, error: err?.message || String(err) });
        return [];
    }
}

/**
 * Return the current slide ID from the headless browser via MCP.
 * Lightweight pre-prompt enrichment — returns null silently on failure.
 */
export async function getCurrentSlideId(projectPath) {
    try {
        const conn = await getMcpClient(projectPath);
        const result = await conn.callTool('coursecode_state', {});
        const text = result?.content?.[0]?.text;
        if (!text) return null;
        const parsed = JSON.parse(text);
        return parsed?.slide || null;
    } catch {
        return null;
    }
}

/**
 * Return the MCP server's instructions (stage-aware authoring context).
 * Returns null if not connected or no instructions available.
 */
export async function getMcpInstructions(projectPath) {
    try {
        const conn = await getMcpClient(projectPath);
        return conn._serverInstructions;
    } catch {
        return null;
    }
}

/**
 * Stop the MCP client for a project.
 */
export function stopMcpClient(projectPath) {
    const conn = connections.get(projectPath);
    if (conn) {
        conn.kill();
        connections.delete(projectPath);
    }
}

/**
 * Stop all MCP clients (called on app quit).
 */
export function killAllMcpClients() {
    for (const [, conn] of connections) {
        // During quit the event loop is tearing down, so use forceKill
        // (synchronous SIGKILL on the entire tree) instead of the graceful
        // SIGTERM → setTimeout → SIGKILL path that conn.kill() uses.
        conn.forceKill();
    }
    connections.clear();
}
