import { spawn } from 'child_process';
import { app } from 'electron';
import { getCLISpawnArgs, getChildEnv } from './node-env.js';
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

class McpConnection {
    constructor(process) {
        this.process = process;
        this.pending = new Map();    // id → { resolve, reject, timer }
        this.buffer = '';
        this.initialized = false;
        this.initPromise = null;

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
            // Reject all pending requests
            for (const [id, entry] of this.pending) {
                clearTimeout(entry.timer);
                entry.reject(new Error(`MCP process exited (code ${code})`));
            }
            this.pending.clear();
        });
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
            return result;
        })();

        return this.initPromise;
    }

    /**
     * Call an MCP tool and return the result.
     */
    async callTool(name, args = {}) {
        await this.initialize();
        const result = await this.request('tools/call', { name, arguments: args });
        return result;
    }

    kill() {
        if (!this.process.killed) {
            this.process.kill('SIGTERM');
            setTimeout(() => {
                if (!this.process.killed) this.process.kill('SIGKILL');
            }, 3000);
        }
    }
}

/**
 * Get or create an MCP connection for a project.
 * Requires the preview server to be running (needs its port).
 */
export async function getMcpClient(projectPath) {
    // Return existing live connection
    const existing = connections.get(projectPath);
    if (existing && !existing.process.killed && existing.process.exitCode == null) {
        return existing;
    }

    // Need preview port
    const port = getPreviewPort(projectPath);
    if (!port) {
        throw new Error('Preview server is not running. Cannot start MCP client.');
    }

    // Spawn coursecode mcp --port <port>
    const { command, args } = getCLISpawnArgs(['mcp', '--port', String(port)]);
    const env = getChildEnv();

    log.info(`Spawning: ${command} ${args.join(' ')}`, { projectPath });
    const child = spawn(command, args, {
        cwd: projectPath,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
    });

    const conn = new McpConnection(child);
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
        conn.kill();
    }
    connections.clear();
}
