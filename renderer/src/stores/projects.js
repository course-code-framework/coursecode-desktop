import { writable, derived } from 'svelte/store';
import { showToast } from './toast.js';

/** List of detected projects. */
export const projects = writable([]);

/** Whether projects are currently loading. */
export const loading = writable(false);

/** Currently selected project path (for Project Detail view). */
export const selectedProjectPath = writable(null);

/** Preview server status per project { [path]: 'running' | 'stopped' }. */
export const previewStatuses = writable({});

/** Get selected project from the list. */
export const selectedProject = derived(
    [projects, selectedProjectPath],
    ([$projects, $path]) => $projects.find(p => p.path === $path) || null
);

/** Scan projects directory. */
export async function refreshProjects() {
    loading.set(true);
    try {
        const list = await window.api.projects.scan();
        projects.set(list);
    } catch (err) {
        showToast({ type: 'error', message: 'Failed to scan projects directory.' });
    } finally {
        loading.set(false);
    }
}
