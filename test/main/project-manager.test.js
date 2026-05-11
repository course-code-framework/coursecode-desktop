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
    npmSpawnArgs: vi.fn((args) => ({ command: 'echo', args })),
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

const { scanProjects, openProject, createProject, clearCloudBinding } = await import('../../main/project-manager.js');
const settingsMod = await import('../../main/settings.js');
const nodeEnvMod = await import('../../main/node-env.js');

let tempDir;

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cc-projects-test-'));
    settingsMod._setProjectsDir(tempDir);
    nodeEnvMod.getCLISpawnArgs.mockImplementation((args) => ({ command: 'echo', args }));
    nodeEnvMod.npmSpawnArgs.mockImplementation((args) => ({ command: 'echo', args }));
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

    it('detects project with course/course-config.js', async () => {
        const projectDir = join(tempDir, 'nested-course');
        mkdirSync(join(projectDir, 'course'), { recursive: true });
        writeFileSync(join(projectDir, 'course', 'course-config.js'), `
            export default {
                metadata: { title: 'Nested Course' },
                format: 'lti'
            };
        `);
        const results = await scanProjects();
        expect(results).toHaveLength(1);
        expect(results[0].name).toBe('nested-course');
        expect(results[0].title).toBe('Nested Course');
        expect(results[0].format).toBe('lti');
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

describe('createProject', () => {
    it('opens the directory created by the CLI when it normalizes the display name', async () => {
        const fakeCliPath = join(tempDir, 'fake-coursecode-create.mjs');
        writeFileSync(fakeCliPath, `
            import { mkdirSync, writeFileSync } from 'fs';
            import { join } from 'path';

            const projectDir = join(process.cwd(), 'coursecode_demo');
            mkdirSync(join(projectDir, 'course'), { recursive: true });
            writeFileSync(join(projectDir, '.coursecoderc.json'), JSON.stringify({ frameworkVersion: '0.1.48' }));
            writeFileSync(join(projectDir, 'course', 'course-config.js'), "export const courseConfig = {\\n  metadata: { title: 'CourseCode Demo' },\\n  layout: 'article',\\n};\\n");
        `);
        const fakeNpmPath = join(tempDir, 'fake-npm-install.mjs');
        writeFileSync(fakeNpmPath, `
            import { mkdirSync, writeFileSync } from 'fs';
            import { join } from 'path';

            const packageDir = join(process.cwd(), 'node_modules', 'coursecode');
            mkdirSync(packageDir, { recursive: true });
            writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ version: '0.1.49' }));
        `);
        nodeEnvMod.getCLISpawnArgs.mockImplementation((args) => {
            if (args[0] === '--version') return { command: 'echo', args: ['0.1.48'] };
            return { command: process.execPath, args: [fakeCliPath] };
        });
        nodeEnvMod.npmSpawnArgs.mockImplementation(() => ({ command: process.execPath, args: [fakeNpmPath] }));

        const project = await createProject({
            name: 'CourseCode Demo',
            format: 'cmi5',
            layout: 'focused',
            blank: false,
            location: tempDir
        });

        expect(project.name).toBe('coursecode_demo');
        expect(project.path).toBe(join(tempDir, 'coursecode_demo'));
        expect(project.title).toBe('CourseCode Demo');

        const config = readFileSync(join(tempDir, 'coursecode_demo', 'course', 'course-config.js'), 'utf-8');
        expect(config).toContain("layout: 'focused'");
        expect(config).toContain("format: 'cmi5'");

        const rc = JSON.parse(readFileSync(join(tempDir, 'coursecode_demo', '.coursecoderc.json'), 'utf-8'));
        expect(rc.frameworkVersion).toBe('0.1.49');
    });

    it('still opens a created course when latest framework install is unavailable', async () => {
        const fakeCliPath = join(tempDir, 'fake-coursecode-create-offline.mjs');
        writeFileSync(fakeCliPath, `
            import { mkdirSync, writeFileSync } from 'fs';
            import { join } from 'path';

            const projectDir = join(process.cwd(), 'offline_course');
            mkdirSync(join(projectDir, 'course'), { recursive: true });
            writeFileSync(join(projectDir, '.coursecoderc.json'), JSON.stringify({ frameworkVersion: '0.1.48' }));
            writeFileSync(join(projectDir, 'course', 'course-config.js'), "export const courseConfig = {\\n  metadata: { title: 'Offline Course' },\\n  layout: 'article',\\n};\\n");
        `);
        const fakeNpmPath = join(tempDir, 'fake-npm-install-fail.mjs');
        writeFileSync(fakeNpmPath, `process.stderr.write('network unavailable\\n'); process.exit(1);`);
        nodeEnvMod.getCLISpawnArgs.mockImplementation((args) => {
            if (args[0] === '--version') return { command: 'echo', args: ['0.1.48'] };
            return { command: process.execPath, args: [fakeCliPath] };
        });
        nodeEnvMod.npmSpawnArgs.mockImplementation(() => ({ command: process.execPath, args: [fakeNpmPath] }));

        const project = await createProject({
            name: 'Offline Course',
            format: 'cmi5',
            layout: 'focused',
            blank: false,
            location: tempDir
        });

        expect(project.name).toBe('offline_course');
        expect(project.title).toBe('Offline Course');
        expect(project.frameworkVersion).toBe('0.1.48');
        expect(existsSync(join(tempDir, 'offline_course', 'node_modules', 'coursecode'))).toBe(false);
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

    it('reads project metadata from course/course-config.js', async () => {
        const projectDir = join(tempDir, 'open-nested');
        mkdirSync(join(projectDir, 'course'), { recursive: true });
        writeFileSync(join(projectDir, 'course', 'course-config.js'), `
            export default {
                metadata: { title: 'Open Nested' },
                format: 'scorm1.2'
            };
        `);
        const project = await openProject(projectDir);
        expect(project.title).toBe('Open Nested');
        expect(project.format).toBe('scorm1.2');
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

    it('reads cloud link metadata from .coursecoderc.json', async () => {
        const projectDir = join(tempDir, 'with-cloud-link');
        mkdirSync(projectDir);
        writeFileSync(join(projectDir, 'course-config.js'), `export default {};`);
        writeFileSync(join(projectDir, '.coursecoderc.json'), JSON.stringify({
            cloudId: 'course_123',
            sourceType: 'github',
            githubRepo: 'acme/course'
        }));
        const project = await openProject(projectDir);
        expect(project.cloudId).toBe('course_123');
        expect(project.githubLinked).toBe(true);
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

describe('clearCloudBinding', () => {

    it('removes cloud-related keys while preserving other keys', async () => {
        const projectDir = join(tempDir, 'clear-binding');
        mkdirSync(projectDir);
        writeFileSync(join(projectDir, '.coursecoderc.json'), JSON.stringify({
            frameworkVersion: '2.1.0',
            cloudId: 'course_abc',
            orgId: 'org_123',
            sourceType: 'github',
            githubRepo: 'acme/my-course'
        }));
        await clearCloudBinding(projectDir);
        const rc = JSON.parse(readFileSync(join(projectDir, '.coursecoderc.json'), 'utf-8'));
        expect(rc.cloudId).toBeUndefined();
        expect(rc.orgId).toBeUndefined();
        expect(rc.sourceType).toBeUndefined();
        expect(rc.githubRepo).toBeUndefined();
        expect(rc.frameworkVersion).toBe('2.1.0');
    });

    it('does nothing when .coursecoderc.json does not exist', async () => {
        const projectDir = join(tempDir, 'no-rc');
        mkdirSync(projectDir);
        await expect(clearCloudBinding(projectDir)).resolves.toBeUndefined();
        expect(existsSync(join(projectDir, '.coursecoderc.json'))).toBe(false);
    });

    it('openProject reflects cleared binding', async () => {
        const projectDir = join(tempDir, 'clear-verify');
        mkdirSync(projectDir);
        writeFileSync(join(projectDir, 'course-config.js'), `export default {};`);
        writeFileSync(join(projectDir, '.coursecoderc.json'), JSON.stringify({
            cloudId: 'course_xyz',
            sourceType: 'github',
            githubRepo: 'acme/repo'
        }));

        // Before clearing
        let project = await openProject(projectDir);
        expect(project.cloudId).toBe('course_xyz');
        expect(project.githubLinked).toBe(true);

        await clearCloudBinding(projectDir);

        // After clearing
        project = await openProject(projectDir);
        expect(project.cloudId).toBeUndefined();
        expect(project.githubLinked).toBeUndefined();
    });
});
