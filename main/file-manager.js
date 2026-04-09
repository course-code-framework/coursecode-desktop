/**
 * file-manager.js — File I/O for the Monaco editor.
 *
 * Security: all paths are validated to stay within the project root.
 * The default listing starts at the course content root (where slides/,
 * course-config.js, media/ live) — not the npm project root.
 */

import { readFile as fsReadFile, writeFile as fsWriteFile } from 'fs/promises';
import { readdir, stat } from 'fs/promises';
import { join, resolve, relative, extname, basename, sep } from 'path';
import { createLogger } from './logger.js';

const log = createLogger('file-manager');

// Directories and files to hide from listings
const IGNORED = new Set([
    'node_modules', '.git', 'dist', 'out', '.cache',
    '.coursecoderc.json', 'package-lock.json',
    '.DS_Store', 'thumbs.db'
]);

// Extension → Monaco language mapping
const LANGUAGE_MAP = {
    '.html': 'html',
    '.htm': 'html',
    '.css': 'css',
    '.js': 'javascript',
    '.mjs': 'javascript',
    '.json': 'json',
    '.md': 'markdown',
    '.txt': 'plaintext',
    '.svg': 'xml'
};

/**
 * Validate that a resolved path stays within the project root.
 * Throws if the path escapes.
 */
function assertWithinProject(projectPath, resolvedPath) {
    const root = resolve(projectPath);
    const target = resolve(resolvedPath);
    if (!target.startsWith(root + sep) && target !== root) {
        throw new Error('Path escapes project root');
    }
}

/**
 * Read a file from the project.
 * @returns {{ content: string, language: string, path: string }}
 */
export async function readProjectFile(projectPath, relativePath) {
    const fullPath = join(projectPath, relativePath);
    assertWithinProject(projectPath, fullPath);

    log.debug('Reading file', { relativePath });
    const content = await fsReadFile(fullPath, 'utf-8');
    const ext = extname(relativePath).toLowerCase();
    const language = LANGUAGE_MAP[ext] || 'plaintext';

    return { content, language, path: relativePath };
}

/**
 * Write a file within the project.
 */
export async function writeProjectFile(projectPath, relativePath, content) {
    const fullPath = join(projectPath, relativePath);
    assertWithinProject(projectPath, fullPath);

    log.info('Writing file', { relativePath, size: content.length });
    await fsWriteFile(fullPath, content, 'utf-8');
}

/**
 * List directory contents. Defaults to project root but excludes
 * node_modules, .git, and other non-content directories.
 * @returns {Array<{ name: string, path: string, type: 'file'|'directory', extension?: string }>}
 */
export async function listDirectory(projectPath, relativePath = '') {
    // Default to the course content directory if it exists
    if (!relativePath) {
        const courseDir = join(projectPath, 'course');
        try {
            const courseStat = await stat(courseDir);
            if (courseStat.isDirectory()) {
                relativePath = 'course';
            }
        } catch (err) {
            log.debug('Course directory not available, listing project root instead', {
                projectPath,
                error: err?.message
            });
            // course/ doesn't exist, fall back to project root
        }
    }

    const dirPath = join(projectPath, relativePath);
    assertWithinProject(projectPath, dirPath);

    log.debug('Listing directory', { relativePath: relativePath || '(root)' });

    const entries = await readdir(dirPath, { withFileTypes: true });
    const results = [];

    for (const entry of entries) {
        const name = entry.name;

        // Skip hidden files (except .coursecoderc.json which we already exclude)
        // and ignored directories/files
        if (name.startsWith('.') || IGNORED.has(name)) continue;

        // Skip package.json at project root (not useful for course content editing)
        if (!relativePath && name === 'package.json') continue;

        const entryRelPath = relativePath ? `${relativePath}/${name}` : name;

        if (entry.isDirectory()) {
            results.push({ name, path: entryRelPath, type: 'directory' });
        } else if (entry.isFile()) {
            const ext = extname(name).toLowerCase();
            // Only show editable file types
            if (LANGUAGE_MAP[ext]) {
                results.push({ name, path: entryRelPath, type: 'file', extension: ext });
            }
        }
    }

    // Sort: directories first, then files, alphabetically within each group
    results.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
    });

    return { entries: results, resolvedPath: relativePath };
}
