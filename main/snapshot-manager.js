import git from 'isomorphic-git';
import fs from 'fs';
import { join, relative } from 'path';
import { createLogger } from './logger.js';

const log = createLogger('snapshot');

const AUTHOR = { name: 'CourseCode Desktop', email: 'noreply@coursecode.ai' };
const PREFIX = '[CourseCode] ';

const DEFAULT_GITIGNORE = `node_modules/
dist/
.coursecode-chat/
*.zip
`;

// --- Pruning thresholds ---
const ONE_DAY = 86400000;
const PRUNE_TIERS = [
    { maxAge: ONE_DAY, maxPerDay: Infinity },
    { maxAge: 7 * ONE_DAY, maxPerDay: 10 },
    { maxAge: 30 * ONE_DAY, maxPerDay: 2 },
    { maxAge: Infinity, maxPerDay: 0 } // milestones only
];
const MILESTONE_LABELS = ['Project created', 'Before export', 'Before deploy'];

/**
 * Initialize a git repo in the project directory if one doesn't exist.
 */
export async function initRepo(projectPath) {
    const dotGit = join(projectPath, '.git');
    if (!fs.existsSync(dotGit)) {
        await git.init({ fs, dir: projectPath, defaultBranch: 'main' });
    }

    // Ensure .gitignore exists (even when .git was created externally, e.g. by the CLI)
    const ignorePath = join(projectPath, '.gitignore');
    if (!fs.existsSync(ignorePath)) {
        fs.writeFileSync(ignorePath, DEFAULT_GITIGNORE);
    }
}

/**
 * Create a snapshot (commit) of the current project state.
 * @param {string} projectPath
 * @param {string} label - Human-readable label
 * @param {object} [metadata] - Optional metadata stored in commit body as JSON
 * @returns {{ id: string, label: string, timestamp: string, summary: object }}
 */
export async function createSnapshot(projectPath, label, metadata) {
    await initRepo(projectPath);

    // Stage all changes.
    // Always re-add every working-directory file instead of relying on
    // statusMatrix's change detection — statusMatrix uses filesystem stat
    // (mtime + size) which misses same-second writes with identical sizes.
    // git.add re-reads content and computes the SHA, so it catches all changes.
    const matrix = await git.statusMatrix({ fs, dir: projectPath });
    for (const [filepath, head, workdir] of matrix) {
        if (workdir === 0) {
            // File deleted from working directory
            await git.remove({ fs, dir: projectPath, filepath });
        } else {
            // File exists — always re-add to bypass stat cache
            await git.add({ fs, dir: projectPath, filepath });
        }
    }

    // Build commit message
    let message = `${PREFIX}${label}`;
    if (metadata) {
        message += `\n\n${JSON.stringify(metadata)}`;
    }

    const sha = await git.commit({
        fs,
        dir: projectPath,
        message,
        author: AUTHOR,
    });

    return {
        id: sha,
        label,
        timestamp: new Date().toISOString(),
        summary: metadata?.files || null,
    };
}

/**
 * List snapshots (CourseCode-created commits only).
 * @param {string} projectPath
 * @param {number} [limit=100]
 * @returns {Array<{ id, label, timestamp, summary, chatIndex? }>}
 */
export async function listSnapshots(projectPath, limit = 100) {
    if (!hasRepo(projectPath)) return [];

    let commits;
    try {
        commits = await git.log({ fs, dir: projectPath, depth: limit + 50 });
    } catch (err) {
        log.debug('Failed to read git log (repo may be empty)', err);
        return []; // Empty repo or no commits
    }

    const snapshots = [];
    for (const commit of commits) {
        const msg = commit.commit.message;
        if (!msg.startsWith(PREFIX)) continue;

        const firstLine = msg.split('\n')[0];
        const label = firstLine.slice(PREFIX.length);

        // Parse metadata from commit body
        let metadata = null;
        const bodyStart = msg.indexOf('\n\n');
        if (bodyStart !== -1) {
            try {
                metadata = JSON.parse(msg.slice(bodyStart + 2));
            } catch (err) { log.debug('Commit body is not JSON', err); }
        }

        snapshots.push({
            id: commit.oid,
            label,
            timestamp: new Date(commit.commit.author.timestamp * 1000).toISOString(),
            summary: metadata?.files || null,
            chatIndex: metadata?.chatIndex ?? null,
        });

        if (snapshots.length >= limit) break;
    }

    return snapshots;
}

/**
 * Restore the project to a specific snapshot.
 * This is a full-state restore — everything after that snapshot is undone.
 * Creates a new snapshot so the restore itself is reversible.
 */
export async function restoreSnapshot(projectPath, snapshotId) {
    if (!hasRepo(projectPath)) throw new Error('No history available');

    // Read the tree at the target commit
    const commit = await git.readCommit({ fs, dir: projectPath, oid: snapshotId });
    const targetTree = commit.commit.tree;

    // Get the label from the target commit
    const msg = commit.commit.message;
    const firstLine = msg.split('\n')[0];
    const targetLabel = firstLine.startsWith(PREFIX) ? firstLine.slice(PREFIX.length) : firstLine;

    // Checkout all files from target commit
    await git.checkout({
        fs,
        dir: projectPath,
        ref: snapshotId,
        force: true,
    });

    // Move HEAD back to the branch tip so we can commit on top
    // Get the current branch
    const branch = await git.currentBranch({ fs, dir: projectPath }) || 'main';

    // We need to re-point HEAD to the branch, then commit the restored state
    // First, reset to the branch ref
    const branchOid = await git.resolveRef({ fs, dir: projectPath, ref: branch }).catch(() => null);

    if (branchOid) {
        // Write the branch ref to HEAD
        fs.writeFileSync(join(projectPath, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
    }

    // Create a restore snapshot
    const changes = await getChangesFromTree(projectPath);
    return createSnapshot(projectPath, `Restored to: ${targetLabel}`, {
        files: changes,
        restoredFrom: snapshotId,
    });
}

/**
 * Get uncommitted changes (working tree vs last commit).
 */
export async function getChanges(projectPath) {
    if (!hasRepo(projectPath)) return { added: [], modified: [], deleted: [] };

    const result = { added: [], modified: [], deleted: [] };

    try {
        const matrix = await git.statusMatrix({ fs, dir: projectPath });
        for (const [filepath, head, workdir] of matrix) {
            if (head === 0 && workdir === 2) result.added.push(filepath);
            else if (head === 1 && workdir === 2) result.modified.push(filepath);
            else if (head === 1 && workdir === 0) result.deleted.push(filepath);
        }
    } catch (err) {
        log.debug('Failed to get status matrix (no commits yet?)', err);
        // No commits yet
    }

    return result;
}

/**
 * Diff a snapshot against its parent — what changed in that snapshot.
 */
export async function diffSnapshot(projectPath, snapshotId) {
    if (!hasRepo(projectPath)) return { added: [], modified: [], deleted: [] };

    const result = { added: [], modified: [], deleted: [] };

    try {
        const commits = await git.log({ fs, dir: projectPath, depth: 200 });
        const idx = commits.findIndex((c) => c.oid === snapshotId);
        if (idx === -1) return result;

        const targetCommit = commits[idx];
        const parentCommit = commits[idx + 1]; // parent is next in log (older)

        if (!parentCommit) {
            // First commit — everything is "added"
            const tree = await listTree(projectPath, targetCommit.oid);
            result.added = tree;
            return result;
        }

        // Walk both trees and compare
        const targetTree = await listTree(projectPath, targetCommit.oid);
        const parentTree = await listTree(projectPath, parentCommit.oid);

        const parentSet = new Set(parentTree);
        const targetSet = new Set(targetTree);

        for (const file of targetTree) {
            if (!parentSet.has(file)) {
                result.added.push(file);
            }
        }
        for (const file of parentTree) {
            if (!targetSet.has(file)) {
                result.deleted.push(file);
            }
        }

        // For files in both, compare blob OIDs
        const parentBlobs = await getBlobMap(projectPath, parentCommit.oid);
        const targetBlobs = await getBlobMap(projectPath, targetCommit.oid);

        for (const file of targetTree) {
            if (parentSet.has(file) && parentBlobs.get(file) !== targetBlobs.get(file)) {
                result.modified.push(file);
            }
        }
    } catch (err) {
        log.debug('diffSnapshot failed', err);
        // Fallback to empty
    }

    return result;
}

/**
 * Check if the project has a git repo.
 */
export function hasRepo(projectPath) {
    return fs.existsSync(join(projectPath, '.git'));
}

/**
 * Prune old snapshots according to the tiered retention policy.
 */
export async function pruneSnapshots(projectPath) {
    // Pruning via isomorphic-git is complex (no native rebase).
    // For v1, we simply track which snapshots are "prunable" but don't
    // actually remove commits — git's pack files keep them compact.
    // This is a no-op placeholder for a future optimization.
    // The listSnapshots function already limits results, so old snapshots
    // just fall off the visible list naturally.
}

// --- Internal helpers ---

/**
 * Get changes by comparing working tree to HEAD (used after checkout).
 */
async function getChangesFromTree(projectPath) {
    const result = { added: [], modified: [], deleted: [] };
    try {
        const matrix = await git.statusMatrix({ fs, dir: projectPath });
        for (const [filepath, head, workdir, stage] of matrix) {
            if (stage !== head || workdir !== head) {
                if (head === 0) result.added.push(filepath);
                else if (workdir === 0) result.deleted.push(filepath);
                else result.modified.push(filepath);
            }
        }
    } catch (err) { log.debug('getChangesFromTree failed', err); }
    return result;
}

/**
 * List all file paths in a commit's tree.
 */
async function listTree(projectPath, oid) {
    const files = [];
    const commit = await git.readCommit({ fs, dir: projectPath, oid });

    async function walk(treeOid, prefix = '') {
        const { tree } = await git.readTree({ fs, dir: projectPath, oid: treeOid });
        for (const entry of tree) {
            const fullPath = prefix ? `${prefix}/${entry.path}` : entry.path;
            if (entry.type === 'tree') {
                await walk(entry.oid, fullPath);
            } else {
                files.push(fullPath);
            }
        }
    }

    await walk(commit.commit.tree);
    return files;
}

/**
 * Get a map of filepath → blob OID for a commit.
 */
async function getBlobMap(projectPath, oid) {
    const map = new Map();
    const commit = await git.readCommit({ fs, dir: projectPath, oid });

    async function walk(treeOid, prefix = '') {
        const { tree } = await git.readTree({ fs, dir: projectPath, oid: treeOid });
        for (const entry of tree) {
            const fullPath = prefix ? `${prefix}/${entry.path}` : entry.path;
            if (entry.type === 'tree') {
                await walk(entry.oid, fullPath);
            } else {
                map.set(fullPath, entry.oid);
            }
        }
    }

    await walk(commit.commit.tree);
    return map;
}
