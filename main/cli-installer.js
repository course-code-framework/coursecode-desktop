import { spawn } from 'child_process';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { shell } from 'electron';
import { getChildEnv, npmSpawnArgs, getCLISpawnArgs } from './node-env.js';
import { saveSetting, getSetting } from './settings.js';
import { loadToken } from './cloud-client.js';
import { detectTools, getToolMeta } from './tool-integrations.js';
import registry from './tool-registry.json';
import { createLogger } from './logger.js';

const log = createLogger('setup');

/**
 * Get the full setup status for all tools.
 */
export async function getSetupStatus() {
    const tools = await detectTools();
    let cliVersion = getSetting('cliVersion');

    if (tools.cli) {
        try {
            cliVersion = await getCLIVersion();
            if (cliVersion && cliVersion !== getSetting('cliVersion')) {
                saveSetting('cliVersion', cliVersion);
            }
        } catch (err) {
            log.debug('Failed to fetch live CLI version, using cached value', err);
        }
    }

    return {
        cli: {
            installed: tools.cli,
            version: cliVersion,
            state: tools.cli ? 'installed-configured' : 'not-installed'
        },
        claudeCode: {
            installed: tools.claudeCode,
            configured: tools.claudeCode ? await isMCPConfigured('claudeCode') : false,
            state: !tools.claudeCode ? 'not-installed'
                : (await isMCPConfigured('claudeCode')) ? 'installed-configured'
                    : 'installed-not-configured'
        },
        vscode: {
            installed: tools.vscode,
            state: tools.vscode ? 'installed-configured' : 'not-installed'
        },
        git: {
            installed: tools.git,
            state: tools.git ? 'installed-configured' : 'not-installed'
        },
        githubDesktop: {
            installed: tools.githubDesktop,
            state: tools.githubDesktop ? 'installed-configured' : 'not-installed'
        },
        cloud: {
            state: loadToken() ? 'installed-configured' : 'not-installed'
        }
    };
}

/**
 * Install the CourseCode CLI globally using bundled Node/npm.
 */
export async function installCLI(webContents) {
    if (await isBundledCLIReady(webContents)) {
        return { success: true, source: 'bundled', version: getSetting('cliVersion') || 'unknown' };
    }

    const cliMeta = registry.tools.cli;
    const { command, args } = npmSpawnArgs(['install', '-g', cliMeta.install.npmPackage]);
    const env = getChildEnv();

    return new Promise((resolve, reject) => {
        if (webContents && !webContents.isDestroyed()) {
            webContents.send('setup:installProgress', {
                type: 'phase',
                phase: 'installing',
                text: 'Installing CourseCode tools...'
            });
        }

        const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stderrBuffer = '';

        child.stdout.on('data', (data) => {
            if (webContents && !webContents.isDestroyed()) {
                webContents.send('setup:installProgress', { type: 'stdout', text: data.toString() });
            }
        });

        child.stderr.on('data', (data) => {
            stderrBuffer += data.toString();
            if (webContents && !webContents.isDestroyed()) {
                webContents.send('setup:installProgress', { type: 'stderr', text: data.toString() });
            }
        });

        child.on('exit', async (code) => {
            if (code !== 0) {
                const detail = stderrBuffer
                    .split(/\r?\n/)
                    .map(line => line.trim())
                    .filter(Boolean)
                    .slice(-6)
                    .join('\n');
                reject(new Error(`CLI installation failed (exit code ${code}).${detail ? `\n${detail}` : ''}`));
                return;
            }

            try {
                if (webContents && !webContents.isDestroyed()) {
                    webContents.send('setup:installProgress', {
                        type: 'phase',
                        phase: 'verifying',
                        text: 'Verifying installation...'
                    });
                }
                const version = await getCLIVersion();
                saveSetting('cliVersion', version);
                if (webContents && !webContents.isDestroyed()) {
                    webContents.send('setup:installProgress', {
                        type: 'phase',
                        phase: 'complete',
                        text: `Installed CourseCode tools (${version})`
                    });
                }
                resolve({ success: true, version });
            } catch (err) {
                log.warn('Failed to get CLI version after install', err);
                if (webContents && !webContents.isDestroyed()) {
                    webContents.send('setup:installProgress', {
                        type: 'phase',
                        phase: 'complete',
                        text: 'Installed CourseCode tools'
                    });
                }
                resolve({ success: true, version: 'unknown' });
            }
        });

        child.on('error', reject);
    });
}

/**
 * Get the installed CLI version.
 */
async function getCLIVersion() {
    return new Promise((resolve, reject) => {
        const cliMeta = registry.tools.cli;
        const { command, args } = getCLISpawnArgs([cliMeta.install.versionFlag]);
        const child = spawn(command, args, {
            env: getChildEnv(),
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let output = '';
        child.stdout.on('data', (data) => { output += data.toString(); });
        child.on('exit', (code) => {
            if (code === 0) resolve(output.trim());
            else reject(new Error('CLI not found'));
        });
        child.on('error', reject);
    });
}

async function isBundledCLIReady(webContents) {
    try {
        const version = await getCLIVersion();
        saveSetting('cliVersion', version);
        if (webContents && !webContents.isDestroyed()) {
            webContents.send('setup:installProgress', {
                type: 'phase',
                phase: 'complete',
                text: `CourseCode tools are ready (${version})`
            });
        }
        return true;
    } catch {
        return false;
    }
}

/**
 * Check if MCP is configured for a given agent.
 */
async function isMCPConfigured(agentId) {
    const meta = getToolMeta(agentId);
    if (!meta?.mcp) return false;

    const mcpPath = join(homedir(), meta.mcp.configDir, meta.mcp.configFile);
    try {
        if (!existsSync(mcpPath)) return false;
        const content = JSON.parse(await readFile(mcpPath, 'utf-8'));

        // Check all possible key paths from registry
        return meta.mcp.detectKeys.some(keyPath => {
            const parts = keyPath.split('.');
            let obj = content;
            for (const part of parts) {
                obj = obj?.[part];
            }
            return obj !== undefined;
        });
    } catch (err) {
        log.debug('Failed to check MCP config', err);
        return false;
    }
}

/**
 * Configure MCP for an AI agent using registry metadata.
 */
export async function configureMCP(agentId) {
    const meta = getToolMeta(agentId);
    if (!meta?.mcp) {
        throw new Error(`No MCP configuration defined for: ${agentId}`);
    }

    const configDir = join(homedir(), meta.mcp.configDir);
    const mcpPath = join(configDir, meta.mcp.configFile);

    // Read existing config or start fresh
    let config = {};
    try {
        if (existsSync(mcpPath)) {
            config = JSON.parse(await readFile(mcpPath, 'utf-8'));
        }
    } catch (err) { log.debug('Failed to read existing MCP config, starting fresh', err); }

    // Write the MCP server entry from registry
    const serverKey = meta.mcp.serverKey;
    if (!config[serverKey]) config[serverKey] = {};
    config[serverKey].coursecode = { ...meta.mcp.entry };

    // Ensure directory exists and write
    if (!existsSync(configDir)) await mkdir(configDir, { recursive: true });
    await writeFile(mcpPath, JSON.stringify(config, null, 2));

    return { success: true };
}

/**
 * Get download URL for a tool from the registry.
 */
export function getDownloadUrl(toolId) {
    return getToolMeta(toolId)?.downloadUrl || null;
}
