import { writable, get } from 'svelte/store';

export const snapshots = writable([]);
export const pendingChanges = writable({ added: [], modified: [], deleted: [] });

export async function loadSnapshots(projectPath) {
    const list = await window.api.snapshots.list(projectPath);
    snapshots.set(list);
}

export async function createSnapshotAction(projectPath, label) {
    const result = await window.api.snapshots.create(projectPath, label);
    await loadSnapshots(projectPath);
    return result;
}

export async function restoreSnapshotAction(projectPath, snapshotId) {
    const result = await window.api.snapshots.restore(projectPath, snapshotId);
    await loadSnapshots(projectPath);
    return result;
}

export async function loadChanges(projectPath) {
    const changes = await window.api.snapshots.changes(projectPath);
    pendingChanges.set(changes);
    return changes;
}

export async function diffSnapshotAction(projectPath, snapshotId) {
    return window.api.snapshots.diff(projectPath, snapshotId);
}
