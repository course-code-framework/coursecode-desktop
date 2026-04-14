import { join } from 'path';
import { readFileSync, readdirSync, existsSync, mkdirSync, copyFileSync, statSync } from 'fs';
import { spawn } from 'child_process';
import { getProjectCLISpawnArgs, getChildEnv } from './node-env.js';

/**
 * List reference markdown documents for a project.
 */
export function listRefs(projectPath) {
    const convertedDir = join(projectPath, 'course', 'references', 'converted');
    if (!existsSync(convertedDir)) return [];

    return readdirSync(convertedDir)
        .filter(f => f.endsWith('.md'))
        .map(filename => {
            const filePath = join(convertedDir, filename);
            const stat = statSync(filePath);
            return {
                filename,
                path: filePath,
                size: stat.size,
                sizeLabel: formatSize(stat.size),
                modified: stat.mtime.toISOString()
            };
        });
}

/**
 * Read a specific reference document's content.
 */
export function readRef(projectPath, filename) {
    const filePath = join(projectPath, 'course', 'references', 'converted', filename);
    if (!existsSync(filePath)) {
        throw new Error(`Reference document not found: ${filename}`);
    }
    const content = readFileSync(filePath, 'utf-8');
    const stat = statSync(filePath);
    return { content, size: stat.size };
}

/**
 * Convert a dropped file by copying to raw/ and running `coursecode convert`.
 * Returns a promise that resolves with { success, outputFile } or rejects with an error.
 */
export function convertRef(projectPath, filePath, webContents) {
    return new Promise((resolve, reject) => {
        if (!filePath) {
            return reject(new Error('No file path provided. Try dragging the file again.'));
        }

        const refsDir = join(projectPath, 'course', 'references');
        if (!existsSync(refsDir)) mkdirSync(refsDir, { recursive: true });

        // Copy file to references/
        const filename = filePath.split('/').pop().split('\\').pop();
        const destPath = join(refsDir, filename);
        copyFileSync(filePath, destPath);

        // Run convert on the references directory
        const { command, args } = getProjectCLISpawnArgs(projectPath, ['convert', refsDir]);
        const child = spawn(command, args, {
            cwd: projectPath,
            env: getChildEnv(),
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let output = '';
        child.stdout.on('data', (data) => {
            output += data.toString();
            if (webContents && !webContents.isDestroyed()) {
                webContents.send('refs:convertProgress', {
                    status: 'converting',
                    text: data.toString()
                });
            }
        });

        child.stderr.on('data', (data) => {
            output += data.toString();
        });

        child.on('close', (code) => {
            if (code === 0) {
                // Find the output file
                const baseName = filename.replace(/\.[^.]+$/, '') + '.md';
                resolve({ success: true, outputFile: baseName });
            } else {
                reject(new Error(`Conversion failed (exit code ${code}): ${output}`));
            }
        });

        child.on('error', (err) => {
            reject(new Error(`Failed to start conversion: ${err.message}`));
        });
    });
}

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
