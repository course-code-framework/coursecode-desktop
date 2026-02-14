import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock electron
vi.mock('electron', () => import('../mocks/electron.js'));

const { readProjectFile, writeProjectFile, listDirectory } = await import('../../main/file-manager.js');

let projectDir;

beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'cc-files-test-'));
});

afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
});

describe('readProjectFile', () => {

    it('reads a file and detects its language', async () => {
        writeFileSync(join(projectDir, 'test.html'), '<h1>Hello</h1>');
        const result = await readProjectFile(projectDir, 'test.html');
        expect(result.content).toBe('<h1>Hello</h1>');
        expect(result.language).toBe('html');
        expect(result.path).toBe('test.html');
    });

    it('detects JavaScript language for .js files', async () => {
        writeFileSync(join(projectDir, 'app.js'), 'const x = 1;');
        const result = await readProjectFile(projectDir, 'app.js');
        expect(result.language).toBe('javascript');
    });

    it('detects JavaScript language for .mjs files', async () => {
        writeFileSync(join(projectDir, 'module.mjs'), 'export default {};');
        const result = await readProjectFile(projectDir, 'module.mjs');
        expect(result.language).toBe('javascript');
    });

    it('detects CSS language', async () => {
        writeFileSync(join(projectDir, 'style.css'), 'body { color: red; }');
        const result = await readProjectFile(projectDir, 'style.css');
        expect(result.language).toBe('css');
    });

    it('detects JSON language', async () => {
        writeFileSync(join(projectDir, 'data.json'), '{}');
        const result = await readProjectFile(projectDir, 'data.json');
        expect(result.language).toBe('json');
    });

    it('detects markdown language', async () => {
        writeFileSync(join(projectDir, 'readme.md'), '# Title');
        const result = await readProjectFile(projectDir, 'readme.md');
        expect(result.language).toBe('markdown');
    });

    it('detects SVG as XML language', async () => {
        writeFileSync(join(projectDir, 'icon.svg'), '<svg></svg>');
        const result = await readProjectFile(projectDir, 'icon.svg');
        expect(result.language).toBe('xml');
    });

    it('falls back to plaintext for unknown extensions', async () => {
        writeFileSync(join(projectDir, 'data.csv'), 'a,b,c');
        const result = await readProjectFile(projectDir, 'data.csv');
        expect(result.language).toBe('plaintext');
    });

    it('throws on path traversal attempt', async () => {
        await expect(
            readProjectFile(projectDir, '../../../etc/passwd')
        ).rejects.toThrow('Path escapes project root');
    });

    it('throws on absolute path injection', async () => {
        await expect(
            readProjectFile(projectDir, '/etc/passwd')
        ).rejects.toThrow();
    });

    it('throws when file does not exist', async () => {
        await expect(
            readProjectFile(projectDir, 'nonexistent.js')
        ).rejects.toThrow();
    });
});

describe('writeProjectFile', () => {

    it('writes content to a file', async () => {
        writeFileSync(join(projectDir, 'output.html'), ''); // create first
        await writeProjectFile(projectDir, 'output.html', '<p>Updated</p>');
        const result = await readProjectFile(projectDir, 'output.html');
        expect(result.content).toBe('<p>Updated</p>');
    });

    it('blocks path traversal on write', async () => {
        await expect(
            writeProjectFile(projectDir, '../../malicious.js', 'evil code')
        ).rejects.toThrow('Path escapes project root');
    });
});

describe('listDirectory', () => {

    it('lists files and directories, sorted correctly', async () => {
        mkdirSync(join(projectDir, 'slides'));
        writeFileSync(join(projectDir, 'app.js'), '');
        writeFileSync(join(projectDir, 'style.css'), '');
        const { entries } = await listDirectory(projectDir, '');
        // Directories come first
        const types = entries.map(e => e.type);
        const dirIndex = types.indexOf('directory');
        const fileIndex = types.indexOf('file');
        if (dirIndex !== -1 && fileIndex !== -1) {
            expect(dirIndex).toBeLessThan(fileIndex);
        }
    });

    it('hides node_modules, .git, and other ignored entries', async () => {
        mkdirSync(join(projectDir, 'node_modules'));
        mkdirSync(join(projectDir, '.git'));
        writeFileSync(join(projectDir, '.DS_Store'), '');
        writeFileSync(join(projectDir, 'visible.js'), '');
        const { entries } = await listDirectory(projectDir, '');
        const names = entries.map(e => e.name);
        expect(names).not.toContain('node_modules');
        expect(names).not.toContain('.git');
        expect(names).not.toContain('.DS_Store');
    });

    it('hides hidden dotfiles', async () => {
        writeFileSync(join(projectDir, '.hidden'), 'secret');
        writeFileSync(join(projectDir, 'visible.js'), '');
        const { entries } = await listDirectory(projectDir, '');
        const names = entries.map(e => e.name);
        expect(names).not.toContain('.hidden');
        expect(names).toContain('visible.js');
    });

    it('only shows editable file types', async () => {
        writeFileSync(join(projectDir, 'image.png'), Buffer.from([0x89]));
        writeFileSync(join(projectDir, 'data.zip'), Buffer.from([0x50]));
        writeFileSync(join(projectDir, 'code.js'), 'export default {};');
        const { entries } = await listDirectory(projectDir, '');
        const names = entries.map(e => e.name);
        expect(names).toContain('code.js');
        expect(names).not.toContain('image.png');
        expect(names).not.toContain('data.zip');
    });

    it('defaults to course/ subdirectory when it exists', async () => {
        mkdirSync(join(projectDir, 'course'));
        writeFileSync(join(projectDir, 'course', 'slide.html'), '<div>slide</div>');
        writeFileSync(join(projectDir, 'package.json'), '{}');
        const result = await listDirectory(projectDir);
        expect(result.resolvedPath).toBe('course');
    });

    it('falls back to project root when course/ does not exist', async () => {
        writeFileSync(join(projectDir, 'app.js'), '');
        const result = await listDirectory(projectDir);
        expect(result.resolvedPath).toBe('');
    });

    it('blocks path traversal in directory listing', async () => {
        await expect(
            listDirectory(projectDir, '../../')
        ).rejects.toThrow('Path escapes project root');
    });

    it('includes extension in file entries', async () => {
        writeFileSync(join(projectDir, 'style.css'), 'body {}');
        const { entries } = await listDirectory(projectDir, '');
        const cssFile = entries.find(e => e.name === 'style.css');
        expect(cssFile?.extension).toBe('.css');
    });
});
