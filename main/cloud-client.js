import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';
import { getChildEnv, isLocalMode } from './node-env.js';
import { createLogger } from './logger.js';

const log = createLogger('cloud');

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
function runCLI(args, { cwd } = {}) {
    if (isLocalMode()) args = [...args, '--local'];
    const token = loadToken();
    const env = getChildEnv(token ? { COURSECODE_CLOUD_TOKEN: token } : {});

    return new Promise((resolve, reject) => {
        const child = spawn('coursecode', args, {
            cwd,
            env,
            stdio: ['ignore', 'pipe', 'pipe']
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
            } catch {
                resolve({ raw: stdout.trim() });
            }
        });

        child.on('error', reject);
    });
}

/**
 * Login via CLI — opens browser, polls for nonce exchange, stores credentials.
 * Sends progress events to webContents so the UI can show a spinner.
 */
export async function cloudLogin(webContents) {
    const env = getChildEnv();

    if (webContents && !webContents.isDestroyed()) {
        webContents.send('cloud:loginProgress', { stage: 'opening', message: 'Opening browser…' });
    }

    return new Promise((resolve, reject) => {
        const child = spawn('coursecode', isLocalMode() ? ['login', '--local'] : ['login'], {
            env,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        child.stdout.on('data', data => {
            const text = data.toString();
            if (webContents && !webContents.isDestroyed()) {
                // Parse CLI output into user-friendly stages
                if (text.includes('Opening browser')) {
                    webContents.send('cloud:loginProgress', { stage: 'waiting', message: 'Waiting for browser authentication…' });
                } else if (text.includes('Logged in')) {
                    webContents.send('cloud:loginProgress', { stage: 'complete', message: 'Signed in!' });
                }
            }
        });

        child.on('exit', async (code) => {
            if (code !== 0) {
                if (webContents && !webContents.isDestroyed()) {
                    webContents.send('cloud:loginProgress', { stage: 'error', message: 'Sign in failed' });
                }
                reject(new Error('Login failed'));
                return;
            }

            // Fetch user info after successful login
            const user = await getCloudUser();

            if (webContents && !webContents.isDestroyed()) {
                webContents.send('cloud:loginProgress', { stage: 'complete', message: 'Signed in!', user });
            }
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
 * Parses CLI output into clean progress stages for the UI.
 * @param {string} projectPath
 * @param {Electron.WebContents} webContents
 * @param {{ message?: string }} [options]
 */
export async function cloudDeploy(projectPath, webContents, options = {}) {
    if (!loadToken()) throw new Error('Not authenticated. Please sign in to CourseCode Cloud.');

    const send = (stage, message, log) => {
        if (webContents && !webContents.isDestroyed()) {
            webContents.send('cloud:deployProgress', { stage, message, log });
        }
    };

    send('building', 'Building course…');

    const token = loadToken();
    const env = getChildEnv({ COURSECODE_CLOUD_TOKEN: token });

    return new Promise((resolve, reject) => {
        const args = isLocalMode() ? ['deploy', '--local'] : ['deploy'];
        if (options.message) args.push('-m', options.message);
        const child = spawn('coursecode', args, {
            cwd: projectPath,
            env,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        child.stdout.on('data', data => {
            const text = data.toString();

            // Map CLI output to user-friendly stages
            if (text.includes('Building')) {
                send('building', 'Building course…', text);
            } else if (text.includes('Deploying') || text.includes('Uploading')) {
                send('uploading', 'Uploading to Cloud…', text);
            } else if (text.includes('✓')) {
                send('complete', 'Deployed!', text);
            } else {
                send(null, null, text); // Log-only, no stage change
            }
        });

        child.stderr.on('data', data => {
            send(null, null, data.toString());
        });

        child.on('exit', code => {
            if (code !== 0) {
                send('error', 'Deploy failed');
                reject(new Error('Deploy failed'));
                return;
            }
            send('complete', 'Deployed!');
            resolve({ success: true, timestamp: new Date().toISOString() });
        });

        child.on('error', reject);
    });
}

/**
 * Get deploy status for a project via CLI.
 */
export async function getDeployStatus(projectPath) {
    if (!loadToken()) return null;

    try {
        return await runCLI(['status', '--json'], { cwd: projectPath });
    } catch {
        return null;
    }
}
