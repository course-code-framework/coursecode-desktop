import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';
import { getChildEnv, isLocalMode, getCLISpawnArgs, getProjectCLISpawnArgs } from './node-env.js';
import { createLogger } from './logger.js';

const log = createLogger('cloud');

/**
 * Strip ANSI escape codes from a string.
 */
function stripAnsi(str) {
    return str.replace(/\x1B\[[0-9;]*m/g, '');
}

/**
 * Extract the meaningful error line from CLI stderr output.
 * Build tools (Vite, Rollup) write warnings to stderr that are not errors.
 * We look for lines starting with a failure marker or containing known error
 * patterns, and fall back to the last non-empty line.
 */
function extractCliError(stderr) {
    const clean = stripAnsi(stderr);
    const lines = clean.split('\n').map(l => l.trim()).filter(Boolean);

    // Lines that are clearly error indicators from the CLI
    const errorIndex = lines.findIndex(l =>
        l.startsWith('✗') ||
        l.startsWith('Error:') ||
        l.startsWith('Validation failed') ||
        l.includes('Could not connect') ||
        l.includes('Not authenticated') ||
        l.includes('not linked') ||
        l.includes('failed')
    );
    if (errorIndex !== -1) {
        const primary = lines[errorIndex].replace(/^✗\s*/, '').replace(/^Error:\s*/, '');
        if (primary.startsWith('Validation failed')) {
            const details = [];
            for (let i = errorIndex + 1; i < lines.length; i += 1) {
                const line = lines[i];
                if (!line) continue;
                if (line.startsWith('(!)')) continue;
                if (line.includes('chunks are larger') || line.includes('manualChunks') || line.includes('chunkSizeWarningLimit')) continue;
                details.push(line.replace(/^[•*-]\s*/, ''));
            }
            return details.length ? `${primary} ${details.join(' ')}` : primary;
        }
        return primary;
    }

    // Fall back to last non-empty line (skip build warnings)
    const filtered = lines.filter(l =>
        !l.startsWith('(!)') &&
        !l.startsWith('-') &&
        !l.includes('chunks are larger') &&
        !l.includes('manualChunks') &&
        !l.includes('chunkSizeWarningLimit') &&
        !l.includes('dynamic import')
    );
    return filtered[filtered.length - 1] || lines[lines.length - 1] || '';
}

function parseCliJson(stdout) {
    const trimmed = stdout.trim();
    if (!trimmed) return null;

    try {
        return JSON.parse(trimmed);
    } catch (err) {
        log.debug('Failed to parse CLI JSON output', { error: err?.message, preview: trimmed.slice(0, 200) });
        return null;
    }
}

function createCloudCliError(message, extra = {}) {
    const err = new Error(message);
    Object.assign(err, extra);
    return err;
}

// CLI manages credentials at ~/.coursecode/credentials.json (or credentials.local.json in local mode)
function getCredentialsPath() {
    const filename = isLocalMode() ? 'credentials.local.json' : 'credentials.json';
    return join(homedir(), '.coursecode', filename);
}

/**
 * Read the token from the CLI's credential file.
 */
export function loadToken() {
    try {
        if (!existsSync(getCredentialsPath())) return null;
        const creds = JSON.parse(readFileSync(getCredentialsPath(), 'utf-8'));
        return creds?.token || null;
    } catch (err) {
        log.warn('Failed to load token', err);
        return null;
    }
}

/**
 * Spawn a CLI command and capture output.
 */
function runCLI(args, { cwd, projectPath } = {}) {
    if (isLocalMode()) args = [...args, '--local'];
    const token = loadToken();
    const env = getChildEnv(token ? { COURSECODE_CLOUD_TOKEN: token } : {});

    return new Promise((resolve, reject) => {
        const { command, args: cliArgs } = projectPath
            ? getProjectCLISpawnArgs(projectPath, args)
            : getCLISpawnArgs(args);
        const useShell = process.platform === 'win32' && command === 'coursecode';
        const child = spawn(command, cliArgs, {
            cwd,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: useShell
        });

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', d => { stdout += d.toString(); });
        child.stderr.on('data', d => { stderr += d.toString(); });

        child.on('exit', code => {
            if (code !== 0) {
                reject(new Error(stderr.trim() || `CLI exited with code ${code}`));
                return;
            }
            try {
                resolve(JSON.parse(stdout));
            } catch (err) {
                log.debug('runCLI stdout was not JSON; returning raw output', {
                    error: err?.message,
                    preview: stdout.trim().slice(0, 200)
                });
                resolve({ raw: stdout.trim() });
            }
        });

        child.on('error', reject);
    });
}

/**
 * Login via CLI — device code flow.
 * CLI emits a JSON line: {"type":"device_code","userCode":"...","verificationUri":"..."}
 * Sends progress events to webContents so the UI can show the code.
 */
export async function cloudLogin(webContents) {
    const env = getChildEnv();

    const send = (data) => {
        if (webContents && !webContents.isDestroyed()) {
            webContents.send('cloud:loginProgress', data);
        }
    };

    send({ stage: 'requesting', message: 'Connecting…' });

    return new Promise((resolve, reject) => {
        const loginArgs = isLocalMode() ? ['login', '--json', '--local'] : ['login', '--json'];
        const { command, args: cliArgs } = getCLISpawnArgs(loginArgs);
        const useShell = process.platform === 'win32' && command === 'coursecode';
        const child = spawn(command, cliArgs, {
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: useShell
        });

        let stderr = '';
        child.stdout.on('data', data => {
            for (const line of data.toString().split('\n')) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                // Device code JSON from CLI
                if (trimmed.startsWith('{')) {
                    try {
                        const parsed = JSON.parse(trimmed);
                        if (parsed.type === 'device_code') {
                            send({ stage: 'device', userCode: parsed.userCode, verificationUri: parsed.verificationUri });
                            continue;
                        }
                    } catch (err) {
                        log.debug('Login stdout line was not JSON; falling through to text parsing', {
                            error: err?.message,
                            preview: trimmed.slice(0, 180)
                        });
                    }
                }

                // Approval confirmed
                if (trimmed.includes('Logged in') || trimmed.includes('approved')) {
                    send({ stage: 'approved', message: 'Approved! Signing in…' });
                }
            }
        });

        child.stderr.on('data', data => { stderr += data.toString(); });

        child.on('exit', async (code) => {
            if (code !== 0) {
                const detail = stderr.trim();
                log.warn('Login CLI exited non-zero', { code, stderr: detail });
                send({ stage: 'error', message: 'Sign in failed' });
                reject(new Error(detail || `Login failed (exit code ${code})`));
                return;
            }

            const user = await getCloudUser();
            send({ stage: 'complete', message: 'Signed in!', user });
            resolve({ success: true, user });
        });

        child.on('error', reject);
    });
}


/**
 * Logout via CLI — deletes credentials.
 */
export async function cloudLogout() {
    return runCLI(['logout']);
}

/**
 * Get current cloud user info via CLI, or null if not authenticated.
 */
export async function getCloudUser() {
    if (!loadToken()) return null;

    try {
        return await runCLI(['whoami', '--json']);
    } catch (err) {
        log.debug('getCloudUser failed (user may not be authenticated)', err);
        return null;
    }
}

/**
 * Deploy a project to CourseCode Cloud via CLI.
 * Uses --json flag to get a clean, parseable result.
 * @param {string} projectPath
 * @param {Electron.WebContents} webContents
 * @param {{ message?: string, promote?: boolean, preview?: boolean, repairBinding?: boolean }} [options]
 */
export async function cloudDeploy(projectPath, webContents, options = {}) {
    if (!loadToken()) throw new Error('Not authenticated. Please sign in to CourseCode Cloud.');

    const send = (stage, message, log) => {
        if (webContents && !webContents.isDestroyed()) {
            webContents.send('cloud:deployProgress', { projectPath, stage, message, log });
        }
    };

    send('building', 'Building course…');

    const token = loadToken();
    const env = getChildEnv({ COURSECODE_CLOUD_TOKEN: token });

    return new Promise((resolve, reject) => {
        const args = isLocalMode() ? ['deploy', '--json', '--local'] : ['deploy', '--json'];
        if (options.message) args.push('-m', options.message);
        if (options.promote) args.push('--promote');
        if (options.preview) args.push('--preview');
        if (options.repairBinding) args.push('--repair-binding');
        const { command, args: cliArgs } = getProjectCLISpawnArgs(projectPath, args);
        const useShell = process.platform === 'win32' && command === 'coursecode';
        const child = spawn(command, cliArgs, {
            cwd: projectPath,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: useShell
        });

        let stdout = '';
        let stderr = '';

        // Send building stage immediately — JSON mode has no text signals
        send('building', 'Building course…');

        child.stdout.on('data', data => {
            const text = data.toString();
            stdout += text;
            // Heuristic: once we see output growing we're past the build step
            if (stdout.length > 10) send('uploading', 'Uploading to Cloud…');
            send(null, null, text);
        });

        child.stderr.on('data', data => {
            stderr += data.toString();
            send(null, null, data.toString());
        });

        child.on('exit', code => {
            const parsed = parseCliJson(stdout);
            if (code !== 0) {
                if (parsed?.errorCode === 'stale_cloud_binding') {
                    reject(createCloudCliError(
                        parsed.error || 'This project is still linked to a deleted CourseCode Cloud course.',
                        {
                            code: 'STALE_CLOUD_BINDING',
                            detail: stderr.trim(),
                            staleBinding: true,
                            payload: parsed,
                        }
                    ));
                    return;
                }

                // stderr contains build warnings (Vite/Rollup chunk size, etc.) mixed
                // with the actual error. Extract only the meaningful error line(s).
                const errorLine = parsed?.error || extractCliError(stderr);
                log.error('Deploy CLI failed', { code, stderr: stderr.trim(), cwd: projectPath });
                send('error', 'Deploy failed');
                reject(new Error(errorLine || `Deploy failed (exit code ${code})`));
                return;
            }
            // Parse JSON result emitted by --json flag
            let dashboardUrl = null;
            let previewUrl = null;
            try {
                if (!parsed) throw new Error('No JSON payload');
                dashboardUrl = parsed.dashboardUrl || null;
                previewUrl = parsed.url || null;
            } catch (err) {
                log.debug('Deploy success payload was not valid JSON; continuing without URLs', {
                    error: err?.message,
                    stdoutPreview: stdout.trim().slice(0, 200)
                });
            }
            send('complete', 'Deployed!');
            resolve({ success: true, timestamp: new Date().toISOString(), dashboardUrl, previewUrl });
        });

        child.on('error', reject);
    });
}

/**
 * Get deploy status for a project via CLI.
 *
 * Unlike most CLI wrappers, this must handle non-zero exits specially:
 * the CLI exits non-zero for stale_cloud_binding, but the dashboard needs
 * that signal as data (not as a swallowed error).
 */
export async function getDeployStatus(projectPath, options = {}) {
    if (!loadToken()) return null;

    try {
        let args = ['status', '--json'];
        if (options.repairBinding) args.push('--repair-binding');
        if (isLocalMode()) args = [...args, '--local'];

        const token = loadToken();
        const env = getChildEnv(token ? { COURSECODE_CLOUD_TOKEN: token } : {});

        return await new Promise((resolve) => {
            const { command, args: cliArgs } = getProjectCLISpawnArgs(projectPath, args);
            const useShell = process.platform === 'win32' && command === 'coursecode';
            const child = spawn(command, cliArgs, {
                cwd: projectPath,
                env,
                stdio: ['ignore', 'pipe', 'pipe'],
                shell: useShell
            });

            let stdout = '';
            child.stdout.on('data', d => { stdout += d.toString(); });
            child.stderr.on('data', () => { });

            child.on('exit', code => {
                const parsed = parseCliJson(stdout);
                if (code !== 0) {
                    // Surface stale_cloud_binding as data so the UI can act on it
                    if (parsed?.errorCode === 'stale_cloud_binding') {
                        resolve(parsed);
                        return;
                    }
                    resolve(null);
                    return;
                }
                resolve(parsed);
            });

            child.on('error', (err) => {
                log.warn('Status CLI spawn failed', { projectPath, error: err?.message });
                resolve(null);
            });
        });
    } catch (err) {
        log.warn('Failed getting deploy status', { projectPath, error: err?.message });
        return null;
    }
}

/**
 * Show or update the course preview link via CLI.
 */
export async function updatePreviewLink(projectPath, options = {}) {
    if (!loadToken()) throw new Error('Not authenticated. Please sign in to CourseCode Cloud.');

    const args = ['preview-link', '--json'];
    if (options.enable) args.push('--enable');
    if (options.disable) args.push('--disable');
    if (options.removePassword) args.push('--remove-password');
    if (options.password) args.push('--password', options.password);
    if (options.format) args.push('--format', options.format);
    if (options.expiresAt) args.push('--expires-at', options.expiresAt);
    if (options.expiresInDays) args.push('--expires-in-days', String(options.expiresInDays));
    if (options.repairBinding) args.push('--repair-binding');
    if (isLocalMode()) args.push('--local');

    return runCLI(args, { cwd: projectPath, projectPath });
}

/**
 * Delete a course from CourseCode Cloud via CLI.
 * Cloud-only: does not touch local files.
 *
 * Returns the full CLI JSON response, which includes sourceType and githubRepo
 * so the caller can surface a GitHub-link warning if needed.
 */
export async function cloudDelete(projectPath) {
    if (!loadToken()) throw new Error('Not authenticated. Please sign in to CourseCode Cloud.');

    const args = ['delete', '--json', '--force'];
    if (isLocalMode()) args.push('--local');
    return runCLI(args, { cwd: projectPath, projectPath });
}
