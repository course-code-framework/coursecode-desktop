import { spawn } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';
import { readdir, stat } from 'fs/promises';
import { shell } from 'electron';
import { getChildEnv, getCLISpawnArgs } from './node-env.js';
import { createSnapshot } from './snapshot-manager.js';
import { createLogger } from './logger.js';

const log = createLogger('build');

/**
 * Build and export a course project.
 * Returns { zipPath, size, duration }.
 */
export async function exportBuild(projectPath, format, webContents) {
    const startTime = Date.now();

    // Auto-snapshot before export
    try { await createSnapshot(projectPath, 'Before export'); } catch (err) { log.debug('Pre-export snapshot failed', err); }

    const env = getChildEnv({ LMS_FORMAT: format || 'cmi5' });

    return new Promise((resolve, reject) => {
        const { command, args } = getCLISpawnArgs(['build', '--format', format || 'cmi5']);
        const child = spawn(command, args, {
            cwd: projectPath,
            env,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        child.stdout.on('data', (data) => {
            if (webContents && !webContents.isDestroyed()) {
                webContents.send('build:progress', { projectPath, type: 'stdout', text: data.toString() });
            }
        });

        child.stderr.on('data', (data) => {
            if (webContents && !webContents.isDestroyed()) {
                webContents.send('build:progress', { projectPath, type: 'stderr', text: data.toString() });
            }
        });

        child.on('exit', async (code) => {
            if (code !== 0) {
                reject(new Error(`Build failed with exit code ${code}`));
                return;
            }

            // Find the generated zip file
            const zipPath = await findZip(projectPath);
            const duration = Date.now() - startTime;

            if (zipPath) {
                const zipStat = await stat(zipPath);
                resolve({ zipPath, size: zipStat.size, duration });
            } else {
                resolve({ zipPath: null, size: 0, duration });
            }
        });

        child.on('error', reject);
    });
}

/**
 * Find the most recent .zip file in the project root.
 */
async function findZip(projectPath) {
    const entries = await readdir(projectPath);
    const zips = entries.filter(e => e.endsWith('.zip'));
    if (zips.length === 0) return null;

    // Return most recent
    let newest = null;
    let newestTime = 0;
    for (const zip of zips) {
        const fullPath = join(projectPath, zip);
        const s = await stat(fullPath);
        if (s.mtimeMs > newestTime) {
            newestTime = s.mtimeMs;
            newest = fullPath;
        }
    }
    return newest;
}

/**
 * Reveal a file in Finder/Explorer.
 */
export function revealInFinder(filePath) {
    shell.showItemInFolder(filePath);
}
