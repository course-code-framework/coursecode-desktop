import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock electron
vi.mock('electron', () => import('../mocks/electron.js'));

// Mock node-env
vi.mock('../../main/node-env.js', () => ({
    getChildEnv: vi.fn(() => ({ ...process.env })),
    getCLISpawnArgs: vi.fn((args) => ({ command: 'echo', args })),
}));

const { listRefs, readRef } = await import('../../main/ref-manager.js');

let projectDir;

beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'cc-refs-test-'));
});

afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
});

describe('listRefs', () => {

    it('returns empty array when no refs directory exists', () => {
        const refs = listRefs(projectDir);
        expect(refs).toEqual([]);
    });

    it('returns empty array when refs directory has no .md files', () => {
        mkdirSync(join(projectDir, 'course', 'references', 'md'), { recursive: true });
        writeFileSync(join(projectDir, 'course', 'references', 'md', 'notes.txt'), 'hi');
        const refs = listRefs(projectDir);
        expect(refs).toEqual([]);
    });

    it('lists markdown reference files with metadata', () => {
        const mdDir = join(projectDir, 'course', 'references', 'md');
        mkdirSync(mdDir, { recursive: true });
        writeFileSync(join(mdDir, 'safety-manual.md'), '# Safety Manual\n\nContent here.');
        writeFileSync(join(mdDir, 'regulations.md'), '# Regulations');

        const refs = listRefs(projectDir);
        expect(refs).toHaveLength(2);

        const names = refs.map(r => r.filename);
        expect(names).toContain('safety-manual.md');
        expect(names).toContain('regulations.md');
    });

    it('includes file size and formatted size', () => {
        const mdDir = join(projectDir, 'course', 'references', 'md');
        mkdirSync(mdDir, { recursive: true });
        writeFileSync(join(mdDir, 'small.md'), 'tiny');

        const refs = listRefs(projectDir);
        expect(refs[0].size).toBeGreaterThan(0);
        expect(refs[0].sizeLabel).toBeTruthy();
    });

    it('includes ISO modified timestamp', () => {
        const mdDir = join(projectDir, 'course', 'references', 'md');
        mkdirSync(mdDir, { recursive: true });
        writeFileSync(join(mdDir, 'doc.md'), 'content');

        const refs = listRefs(projectDir);
        const ts = new Date(refs[0].modified);
        expect(ts.getTime()).not.toBeNaN();
    });
});

describe('readRef', () => {

    it('reads a reference document', () => {
        const mdDir = join(projectDir, 'course', 'references', 'md');
        mkdirSync(mdDir, { recursive: true });
        writeFileSync(join(mdDir, 'guide.md'), '# User Guide\n\nStep 1...');

        const result = readRef(projectDir, 'guide.md');
        expect(result.content).toBe('# User Guide\n\nStep 1...');
        expect(result.size).toBeGreaterThan(0);
    });

    it('throws for non-existent reference', () => {
        expect(() => readRef(projectDir, 'no-such-file.md'))
            .toThrow('Reference document not found');
    });
});

describe('formatSize (tested indirectly via listRefs)', () => {

    it('formats bytes correctly', () => {
        const mdDir = join(projectDir, 'course', 'references', 'md');
        mkdirSync(mdDir, { recursive: true });
        writeFileSync(join(mdDir, 'tiny.md'), 'ab'); // 2 bytes

        const refs = listRefs(projectDir);
        expect(refs[0].sizeLabel).toBe('2 B');
    });

    it('formats kilobytes correctly', () => {
        const mdDir = join(projectDir, 'course', 'references', 'md');
        mkdirSync(mdDir, { recursive: true });
        // Write ~2KB file
        writeFileSync(join(mdDir, 'medium.md'), 'x'.repeat(2048));

        const refs = listRefs(projectDir);
        expect(refs[0].sizeLabel).toContain('KB');
    });

    it('formats megabytes correctly', () => {
        const mdDir = join(projectDir, 'course', 'references', 'md');
        mkdirSync(mdDir, { recursive: true });
        // Write ~1.5MB file
        writeFileSync(join(mdDir, 'large.md'), 'y'.repeat(1536 * 1024));

        const refs = listRefs(projectDir);
        expect(refs[0].sizeLabel).toContain('MB');
    });
});
