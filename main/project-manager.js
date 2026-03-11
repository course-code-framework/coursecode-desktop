import { readdir, stat, readFile, writeFile } from 'fs/promises';
import { join, basename } from 'path';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { shell } from 'electron';
import { getSetting } from './settings.js';
import { getChildEnv, getCLISpawnArgs } from './node-env.js';
import { initRepo, createSnapshot } from './snapshot-manager.js';
import { stopPreview } from './preview-manager.js';
import { stopGeneration } from './chat-engine.js';
import { createLogger } from './logger.js';

const log = createLogger('project');

const ALLOWED_FORMATS = new Set(['cmi5', 'scorm2004', 'scorm1.2', 'lti']);
const ALLOWED_LAYOUTS = new Set(['article', 'traditional', 'presentation', 'focused', 'canvas']);

/**
 * Scan the projects directory for CourseCode projects.
 * A project is detected by the presence of course-config.js.
 */
export async function scanProjects() {
    const projectsDir = getSetting('projectsDir');
    if (!existsSync(projectsDir)) return [];

    const entries = await readdir(projectsDir, { withFileTypes: true });
    const projects = [];

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const projectPath = join(projectsDir, entry.name);
        const configPath = join(projectPath, 'course-config.js');
        const rcPath = join(projectPath, '.coursecoderc.json');

        if (!existsSync(configPath) && !existsSync(rcPath)) continue;

        const project = {
            name: entry.name,
            path: projectPath,
            title: entry.name,
            format: 'cmi5',
            lastModified: null,
            frameworkVersion: null
        };

        // Read metadata from .coursecoderc.json if available
        try {
            if (existsSync(rcPath)) {
                const rc = JSON.parse(await readFile(rcPath, 'utf-8'));
                if (rc.frameworkVersion) project.frameworkVersion = rc.frameworkVersion;
                // Cloud binding — used by the Desktop UI for deploy guard and delete dialog
                if (rc.cloudId) project.cloudId = rc.cloudId;
                if (rc.sourceType === 'github') project.githubLinked = true;
            }
        } catch { /* ignore parse errors */ }

        // Read title/format from course-config.js via regex (fast, no eval)
        try {
            if (existsSync(configPath)) {
                const configContent = await readFile(configPath, 'utf-8');
                const titleMatch = configContent.match(/title\s*:\s*['"](.+?)['"]/);
                if (titleMatch) project.title = titleMatch[1];
                const formatMatch = configContent.match(/format\s*:\s*['"](.+?)['"]/);
                if (formatMatch) project.format = formatMatch[1];
            }
        } catch { /* ignore */ }

        // Get last modified time
        try {
            const stats = await stat(projectPath);
            project.lastModified = stats.mtime.toISOString();
        } catch { /* ignore */ }

        projects.push(project);
    }

    return projects.sort((a, b) => {
        if (!a.lastModified || !b.lastModified) return 0;
        return new Date(b.lastModified) - new Date(a.lastModified);
    });
}

/**
 * Create a new course project by delegating to `coursecode create`.
 */
export async function createProject({ name, format, layout, blank, location }) {
    const projectsDir = location || getSetting('projectsDir');
    const targetDir = join(projectsDir, name);

    if (existsSync(targetDir)) {
        throw new Error(`Project directory already exists: ${targetDir}`);
    }

    await ensureCLIReady();

    const args = ['create', name];
    if (blank) args.push('--blank');

    const env = getChildEnv();

    const { command, args: spawnArgs } = getCLISpawnArgs(args);

    return new Promise((resolve, reject) => {
        const child = spawn(command, spawnArgs, {
            cwd: projectsDir,
            env,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stderr = '';
        // Drain stdout to prevent pipe buffer deadlock on Windows
        child.stdout.resume();
        child.stderr.on('data', d => { stderr += d.toString(); });

        child.on('exit', async (code) => {
            if (code !== 0) {
                reject(new Error(stderr.trim() || `coursecode create failed with exit code ${code}`));
                return;
            }

            // Initialize snapshot tracking for the new project
            try {
                await applyProjectPreferences(targetDir, { format, layout });
                await initRepo(targetDir);
                await createSnapshot(targetDir, 'Project created');
            } catch { /* ignore snapshot init errors */ }

            // Read back the created project metadata
            resolve(await openProject(targetDir));
        });

        child.on('error', reject);
    });
}

async function applyProjectPreferences(projectDir, { format, layout }) {
    const nextFormat = ALLOWED_FORMATS.has(format) ? format : null;
    const nextLayout = ALLOWED_LAYOUTS.has(layout) ? layout : null;
    if (!nextFormat && !nextLayout) return;

    const configPath = join(projectDir, 'course', 'course-config.js');
    if (!existsSync(configPath)) return;

    let content = await readFile(configPath, 'utf-8');

    if (nextLayout) {
        const layoutPattern = /^(\s*)layout\s*:\s*['"`][^'"`]*['"`]\s*,/m;
        content = content.replace(layoutPattern, `$1layout: '${nextLayout}',`);
    }

    if (nextFormat) {
        const formatPattern = /^(\s*)format\s*:\s*['"`][^'"`]*['"`]\s*,/m;
        if (formatPattern.test(content)) {
            content = content.replace(formatPattern, `$1format: '${nextFormat}',`);
        } else {
            const layoutLinePattern = /^(\s*)layout\s*:\s*['"`][^'"`]*['"`]\s*,\n?/m;
            if (layoutLinePattern.test(content)) {
                content = content.replace(layoutLinePattern, (line, indent) => `${line}${indent}format: '${nextFormat}',\n`);
            } else {
                const metadataBlockPattern = /^(\s*)metadata\s*:\s*\{[\s\S]*?^\1\}\s*,\n?/m;
                content = content.replace(metadataBlockPattern, (block, indent) => `${block}${indent}format: '${nextFormat}',\n`);
            }
        }
    }

    await writeFile(join(projectDir, 'course', 'course-config.js'), content, 'utf-8');
}

async function ensureCLIReady() {
    const { command, args } = getCLISpawnArgs(['--version']);
    const env = getChildEnv();

    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            env,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stderr = '';
        // Drain stdout to prevent pipe buffer deadlock on Windows
        child.stdout.resume();
        child.stderr.on('data', d => { stderr += d.toString(); });

        child.on('error', (err) => {
            err.code = err.code || 'CLI_NOT_READY';
            reject(err);
        });

        child.on('exit', (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            const err = new Error(stderr.trim() || `coursecode --version exited with code ${code}`);
            err.code = 'CLI_NOT_READY';
            reject(err);
        });
    });
}

/**
 * Open a project and return its full details.
 */
export async function openProject(projectPath) {
    const configPath = join(projectPath, 'course-config.js');
    const rcPath = join(projectPath, '.coursecoderc.json');

    const project = {
        name: basename(projectPath),
        path: projectPath,
        title: basename(projectPath),
        format: 'cmi5',
        lastModified: null,
        frameworkVersion: null
    };

    try {
        if (existsSync(rcPath)) {
            const rc = JSON.parse(await readFile(rcPath, 'utf-8'));
            if (rc.frameworkVersion) project.frameworkVersion = rc.frameworkVersion;
            if (rc.cloudId) project.cloudId = rc.cloudId;
            if (rc.sourceType === 'github') project.githubLinked = true;
        }
    } catch { /* ignore */ }

    try {
        if (existsSync(configPath)) {
            const content = await readFile(configPath, 'utf-8');
            const titleMatch = content.match(/title\s*:\s*['"](.+?)['"]/);
            if (titleMatch) project.title = titleMatch[1];
            const formatMatch = content.match(/format\s*:\s*['"](.+?)['"]/);
            if (formatMatch) project.format = formatMatch[1];
        }
    } catch { /* ignore */ }

    try {
        const stats = await stat(projectPath);
        project.lastModified = stats.mtime.toISOString();
    } catch { /* ignore */ }

    return project;
}

/**
 * Delete a project.
 *
 * Stops any running preview server and active AI chat first so file handles
 * are released (required on Windows where open handles block trash/delete).
 *
 * options.deleteFromCloud: if true, removes the course from CourseCode Cloud
 * first (via CLI), then moves local files to trash regardless.
 * The Desktop UI is responsible for reading cloudId from .coursecoderc.json
 * and showing any confirmation dialog (including GitHub-link warnings) before
 * calling this.
 */
export async function deleteProject(projectPath, options = {}) {
    // Release file handles: stop preview server and abort active chat
    try {
        stopGeneration(projectPath);
        await stopPreview(projectPath);
    } catch (cleanupErr) {
        log.warn('Pre-delete cleanup failed (continuing anyway)', cleanupErr);
    }

    if (options.deleteFromCloud) {
        const { cloudDelete } = await import('./cloud-client.js');
        await cloudDelete(projectPath);
    }

    try {
        await shell.trashItem(projectPath);
    } catch (err) {
        const wrapped = new Error(
            `Couldn't move "${basename(projectPath)}" to trash: ${err.message}`
        );
        wrapped.code = err.code;
        wrapped.cause = err;
        throw wrapped;
    }
}

/**
 * Remove cloud binding from a project's .coursecoderc.json.
 *
 * Deletes cloud-related keys while preserving other metadata
 * (frameworkVersion, etc.).
 */
export async function clearCloudBinding(projectPath) {
    const rcPath = join(projectPath, '.coursecoderc.json');
    if (!existsSync(rcPath)) return;

    const rc = JSON.parse(await readFile(rcPath, 'utf-8'));
    delete rc.cloudId;
    delete rc.orgId;
    delete rc.sourceType;
    delete rc.githubRepo;
    await writeFile(rcPath, JSON.stringify(rc, null, 2) + '\n', 'utf-8');
    log.info('Cleared cloud binding', { projectPath });
}
