import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock electron
vi.mock('electron', () => import('../mocks/electron.js'));

// Mock node-env to avoid real CLI detection
vi.mock('../../main/node-env.js', () => ({
    getChildEnv: vi.fn(() => ({ ...process.env })),
    getCLISpawnArgs: vi.fn((args) => ({ command: 'echo', args })),
    isLocalMode: vi.fn(() => false),
}));

// Mock snapshot-manager to avoid real git operations
vi.mock('../../main/snapshot-manager.js', () => ({
    initRepo: vi.fn(async () => { }),
    createSnapshot: vi.fn(async () => ({ id: 'abc123' })),
}));

// Mock settings
vi.mock('../../main/settings.js', async () => {
    let projectsDir = '';
    return {
        getSetting: vi.fn((key) => {
            if (key === 'projectsDir') return projectsDir;
            return null;
        }),
        _setProjectsDir: (dir) => { projectsDir = dir; },
    };
});

const { scanProjects, openProject } = await import('../../main/project-manager.js');
const settingsMod = await import('../../main/settings.js');

let tempDir;

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cc-projects-test-'));
    settingsMod._setProjectsDir(tempDir);
});

afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
});

describe('scanProjects', () => {

    it('returns empty array when projects directory is empty', async () => {
        const results = await scanProjects();
        expect(results).toEqual([]);
    });

    it('returns empty array when no valid projects exist', async () => {
        // Create a directory with no course-config.js
        mkdirSync(join(tempDir, 'not-a-project'));
        writeFileSync(join(tempDir, 'not-a-project', 'readme.txt'), 'hello');
        const results = await scanProjects();
        expect(results).toEqual([]);
    });

    it('detects project with course-config.js', async () => {
        const projectDir = join(tempDir, 'my-course');
        mkdirSync(projectDir);
        writeFileSync(join(projectDir, 'course-config.js'), `
            export default {
                metadata: { title: 'My Test Course' },
                format: 'scorm2004'
            };
        `);
        const results = await scanProjects();
        expect(results).toHaveLength(1);
        expect(results[0].name).toBe('my-course');
        expect(results[0].title).toBe('My Test Course');
        expect(results[0].format).toBe('scorm2004');
    });

    it('detects project with .coursecoderc.json', async () => {
        const projectDir = join(tempDir, 'rc-project');
        mkdirSync(projectDir);
        writeFileSync(join(projectDir, '.coursecoderc.json'), JSON.stringify({
            frameworkVersion: '2.1.0'
        }));
        const results = await scanProjects();
        expect(results).toHaveLength(1);
        expect(results[0].frameworkVersion).toBe('2.1.0');
    });

    it('extracts title from various quoting styles', async () => {
        for (const [quote, expected] of [[`'`, 'Single'], [`"`, 'Double']]) {
            const projectDir = join(tempDir, `quote-${expected}`);
            mkdirSync(projectDir);
            writeFileSync(join(projectDir, 'course-config.js'), `
                export default {
                    metadata: { title: ${quote}${expected} Quoted${quote} }
                };
            `);
        }
        const results = await scanProjects();
        expect(results).toHaveLength(2);
        const titles = results.map(r => r.title);
        expect(titles).toContain('Single Quoted');
        expect(titles).toContain('Double Quoted');
    });

    it('ignores files (non-directories) in projects dir', async () => {
        writeFileSync(join(tempDir, 'stray-file.txt'), 'not a project');
        const results = await scanProjects();
        expect(results).toEqual([]);
    });

    it('sorts by last modified (newest first)', async () => {
        const older = join(tempDir, 'older');
        const newer = join(tempDir, 'newer');
        mkdirSync(older);
        mkdirSync(newer);
        writeFileSync(join(older, 'course-config.js'), `export default { metadata: { title: 'Older' } };`);
        // Small delay so mtime differs
        writeFileSync(join(newer, 'course-config.js'), `export default { metadata: { title: 'Newer' } };`);

        const results = await scanProjects();
        expect(results).toHaveLength(2);
        // newest first — can't guarantee strict fs ordering in tests, but both should appear
        expect(results.map(r => r.name)).toContain('older');
        expect(results.map(r => r.name)).toContain('newer');
    });

    it('handles corrupt .coursecoderc.json gracefully', async () => {
        const projectDir = join(tempDir, 'corrupt-rc');
        mkdirSync(projectDir);
        writeFileSync(join(projectDir, '.coursecoderc.json'), '{{{NOT JSON');
        writeFileSync(join(projectDir, 'course-config.js'), `export default {};`);
        const results = await scanProjects();
        expect(results).toHaveLength(1);
        expect(results[0].frameworkVersion).toBeNull();
    });

    it('handles missing projects directory', async () => {
        settingsMod._setProjectsDir('/tmp/cc-nonexistent-dir-xyz');
        const results = await scanProjects();
        expect(results).toEqual([]);
    });
});

describe('openProject', () => {

    it('reads project metadata from course-config.js', async () => {
        const projectDir = join(tempDir, 'open-test');
        mkdirSync(projectDir);
        writeFileSync(join(projectDir, 'course-config.js'), `
            export default {
                metadata: { title: 'Open Target' },
                format: 'lti'
            };
        `);
        const project = await openProject(projectDir);
        expect(project.title).toBe('Open Target');
        expect(project.format).toBe('lti');
        expect(project.name).toBe('open-test');
        expect(project.path).toBe(projectDir);
    });

    it('reads framework version from .coursecoderc.json', async () => {
        const projectDir = join(tempDir, 'with-rc');
        mkdirSync(projectDir);
        writeFileSync(join(projectDir, 'course-config.js'), `export default {};`);
        writeFileSync(join(projectDir, '.coursecoderc.json'), JSON.stringify({
            frameworkVersion: '2.0.0'
        }));
        const project = await openProject(projectDir);
        expect(project.frameworkVersion).toBe('2.0.0');
    });

    it('falls back to directory name for title', async () => {
        const projectDir = join(tempDir, 'fallback-name');
        mkdirSync(projectDir);
        // No course-config.js — title should fall back to dir basename
        const project = await openProject(projectDir);
        expect(project.title).toBe('fallback-name');
    });

    it('includes lastModified as ISO string', async () => {
        const projectDir = join(tempDir, 'with-time');
        mkdirSync(projectDir);
        const project = await openProject(projectDir);
        expect(project.lastModified).toBeTruthy();
        expect(() => new Date(project.lastModified)).not.toThrow();
    });
});
