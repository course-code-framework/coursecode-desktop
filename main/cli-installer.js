import { spawn } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';
import { shell } from 'electron';
import { getChildEnv, npmSpawnArgs, getCLISpawnArgs } from './node-env.js';
import { saveSetting, getSetting } from './settings.js';
import { loadToken } from './cloud-client.js';
import { detectTools } from './tool-integrations.js';
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
        // On Windows, bare command names (e.g. 'coursecode') resolve via .cmd shims
        // which require shell:true. When we have a direct path to cli.js we skip shell.
        const useShell = process.platform === 'win32' && command === 'coursecode';
        const child = spawn(command, args, {
            env: getChildEnv(),
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: useShell
        });

        let output = '';
        child.stdout.on('data', (data) => { output += data.toString(); });
        // Drain stderr to prevent pipe buffer deadlock on Windows
        child.stderr.resume();
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
    } catch (err) {
        log.debug('Bundled CLI readiness check failed', err);
        return false;
    }
}

/**
 * Get download URL for a tool from the registry.
 */
export function getDownloadUrl(toolId) {
    return registry.tools[toolId]?.downloadUrl || null;
}

/**
 * Fetch the latest published version of the coursecode npm package.
 *
 * Hits the npm registry API and caches the result for 15 minutes to avoid
 * excessive network calls. Returns null if the registry is unreachable.
 */
let _latestVersionCache = { version: null, fetchedAt: 0 };
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

export async function getLatestFrameworkVersion() {
    const now = Date.now();
    if (_latestVersionCache.version && (now - _latestVersionCache.fetchedAt) < CACHE_TTL_MS) {
        return _latestVersionCache.version;
    }

    const packageName = registry.tools.cli?.install?.npmPackage || 'coursecode';

    try {
        const { default: https } = await import('https');
        const version = await new Promise((resolve, reject) => {
            const req = https.get(`https://registry.npmjs.org/${packageName}/latest`, {
                headers: { 'Accept': 'application/json' },
                timeout: 8000
            }, (res) => {
                let body = '';
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => {
                    try {
                        const data = JSON.parse(body);
                        resolve(data.version || null);
                    } catch {
                        resolve(null);
                    }
                });
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
        });

        if (version) {
            _latestVersionCache = { version, fetchedAt: now };
        }
        return version;
    } catch (err) {
        log.debug('Failed to fetch latest framework version from npm', err);
        return _latestVersionCache.version || null; // Return stale cache if available
    }
}
