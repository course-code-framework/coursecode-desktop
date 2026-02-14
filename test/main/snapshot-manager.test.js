import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock electron
vi.mock('electron', () => import('../mocks/electron.js'));

const {
    initRepo, createSnapshot, listSnapshots, getChanges, hasRepo, diffSnapshot
} = await import('../../main/snapshot-manager.js');

let projectDir;

beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'cc-snapshot-test-'));
});

afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
});

describe('initRepo', () => {

    it('creates a .git directory', async () => {
        await initRepo(projectDir);
        expect(existsSync(join(projectDir, '.git'))).toBe(true);
    });

    it('creates a default .gitignore', async () => {
        await initRepo(projectDir);
        const gitignore = readFileSync(join(projectDir, '.gitignore'), 'utf-8');
        expect(gitignore).toContain('node_modules/');
        expect(gitignore).toContain('.coursecode-chat/');
    });

    it('does not overwrite existing .gitignore', async () => {
        writeFileSync(join(projectDir, '.gitignore'), 'custom-ignore');
        await initRepo(projectDir);
        const gitignore = readFileSync(join(projectDir, '.gitignore'), 'utf-8');
        expect(gitignore).toBe('custom-ignore');
    });

    it('is idempotent (second call is a no-op)', async () => {
        await initRepo(projectDir);
        // Should not throw or recreate
        await initRepo(projectDir);
        expect(existsSync(join(projectDir, '.git'))).toBe(true);
    });
});

describe('hasRepo', () => {

    it('returns false for a directory without .git', () => {
        expect(hasRepo(projectDir)).toBe(false);
    });

    it('returns true after initRepo', async () => {
        await initRepo(projectDir);
        expect(hasRepo(projectDir)).toBe(true);
    });
});

describe('createSnapshot', () => {

    it('creates a commit and returns snapshot metadata', async () => {
        writeFileSync(join(projectDir, 'file.txt'), 'hello');
        const snap = await createSnapshot(projectDir, 'Initial state');
        expect(snap.id).toBeTruthy();
        expect(snap.id.length).toBe(40); // SHA-1 hex
        expect(snap.label).toBe('Initial state');
        expect(snap.timestamp).toBeTruthy();
    });

    it('includes metadata in the commit body as JSON', async () => {
        writeFileSync(join(projectDir, 'test.js'), 'const x = 1;');
        const snap = await createSnapshot(projectDir, 'AI changes', {
            chatIndex: 3,
            files: { modified: ['test.js'] }
        });
        expect(snap.id).toBeTruthy();
        expect(snap.summary).toEqual({ modified: ['test.js'] });
    });

    it('tracks file additions across snapshots', async () => {
        writeFileSync(join(projectDir, 'first.txt'), 'a');
        await createSnapshot(projectDir, 'First');

        writeFileSync(join(projectDir, 'second.txt'), 'b');
        const snap2 = await createSnapshot(projectDir, 'Second');
        expect(snap2.id).toBeTruthy();
    });
});

describe('listSnapshots', () => {

    it('returns empty array when no repo exists', async () => {
        const snaps = await listSnapshots(projectDir);
        expect(snaps).toEqual([]);
    });

    it('returns empty array for empty repo', async () => {
        await initRepo(projectDir);
        const snaps = await listSnapshots(projectDir);
        expect(snaps).toEqual([]);
    });

    it('lists CourseCode commits and extracts labels', async () => {
        writeFileSync(join(projectDir, 'file.txt'), 'v1');
        await createSnapshot(projectDir, 'Project created');

        writeFileSync(join(projectDir, 'file.txt'), 'v2');
        await createSnapshot(projectDir, 'AI: Added welcome slide');

        const snaps = await listSnapshots(projectDir);
        expect(snaps).toHaveLength(2);
        // Newest first (git log order)
        expect(snaps[0].label).toBe('AI: Added welcome slide');
        expect(snaps[1].label).toBe('Project created');
    });

    it('extracts chatIndex from metadata', async () => {
        writeFileSync(join(projectDir, 'file.txt'), 'hi');
        await createSnapshot(projectDir, 'Chat turn', { chatIndex: 7 });

        const snaps = await listSnapshots(projectDir);
        expect(snaps[0].chatIndex).toBe(7);
    });

    it('respects the limit parameter', async () => {
        writeFileSync(join(projectDir, 'file.txt'), '1');
        await createSnapshot(projectDir, 'Snap 1');
        writeFileSync(join(projectDir, 'file.txt'), '2');
        await createSnapshot(projectDir, 'Snap 2');
        writeFileSync(join(projectDir, 'file.txt'), '3');
        await createSnapshot(projectDir, 'Snap 3');

        const snaps = await listSnapshots(projectDir, 2);
        expect(snaps).toHaveLength(2);
    });

    it('provides ISO timestamp for each snapshot', async () => {
        writeFileSync(join(projectDir, 'file.txt'), 'ts test');
        await createSnapshot(projectDir, 'Test');

        const snaps = await listSnapshots(projectDir);
        const ts = new Date(snaps[0].timestamp);
        expect(ts.getTime()).not.toBeNaN();
    });
});

describe('getChanges', () => {

    it('returns empty changes when no repo exists', async () => {
        const changes = await getChanges(projectDir);
        expect(changes).toEqual({ added: [], modified: [], deleted: [] });
    });

    it('detects added files', async () => {
        writeFileSync(join(projectDir, 'initial.txt'), 'init');
        await createSnapshot(projectDir, 'Init');

        writeFileSync(join(projectDir, 'new-file.txt'), 'new');
        const changes = await getChanges(projectDir);
        expect(changes.added).toContain('new-file.txt');
    });

    it('detects modified files', async () => {
        writeFileSync(join(projectDir, 'mutable.txt'), 'original');
        await createSnapshot(projectDir, 'Init');

        writeFileSync(join(projectDir, 'mutable.txt'), 'changed');
        const changes = await getChanges(projectDir);
        expect(changes.modified).toContain('mutable.txt');
    });
});

describe('diffSnapshot', () => {

    it('returns empty for non-existent repo', async () => {
        const diff = await diffSnapshot(projectDir, 'fake-oid');
        expect(diff).toEqual({ added: [], modified: [], deleted: [] });
    });

    it('shows all files as added for first commit', async () => {
        writeFileSync(join(projectDir, 'one.txt'), '1');
        writeFileSync(join(projectDir, 'two.txt'), '2');
        const snap = await createSnapshot(projectDir, 'First');

        const diff = await diffSnapshot(projectDir, snap.id);
        expect(diff.added).toContain('one.txt');
        expect(diff.added).toContain('two.txt');
        expect(diff.modified).toHaveLength(0);
        expect(diff.deleted).toHaveLength(0);
    });

    it('detects added files between commits', async () => {
        writeFileSync(join(projectDir, 'base.txt'), 'base');
        await createSnapshot(projectDir, 'Base');

        writeFileSync(join(projectDir, 'added.txt'), 'new');
        const snap2 = await createSnapshot(projectDir, 'Added file');

        const diff = await diffSnapshot(projectDir, snap2.id);
        expect(diff.added).toContain('added.txt');
    });

    it('detects modified files between commits (same-length content)', async () => {
        // This is the regression test for the stat-cache bug:
        // isomorphic-git's statusMatrix uses mtime+size for change detection.
        // Same-second writes with identical file sizes were previously invisible.
        writeFileSync(join(projectDir, 'file.txt'), 'aaaa');
        await createSnapshot(projectDir, 'V1');

        writeFileSync(join(projectDir, 'file.txt'), 'bbbb'); // same length!
        const snap2 = await createSnapshot(projectDir, 'V2');

        const diff = await diffSnapshot(projectDir, snap2.id);
        expect(diff.modified).toContain('file.txt');
    });
});
