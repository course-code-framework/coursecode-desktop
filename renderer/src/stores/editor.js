/**
 * editor.js — Svelte store for the Monaco editor panel state.
 */
import { writable, derived } from 'svelte/store';

// Currently open file
export const openFile = writable(null); // { path, content, language } | null

// Original content from disk (for dirty detection)
const savedContent = writable(null);

// Current editor content (updated on edits)
export const editorContent = writable(null);

// Whether the file has unsaved changes
export const dirty = derived(
    [editorContent, savedContent],
    ([$editorContent, $savedContent]) => {
        if ($editorContent === null || $savedContent === null) return false;
        return $editorContent !== $savedContent;
    }
);

// Current directory listing
export const currentDir = writable(''); // relative path
export const dirEntries = writable([]); // FileEntry[]

/**
 * Load a directory listing via IPC.
 */
export async function loadDirectory(projectPath, relativePath = '') {
    const result = await window.api.files.listDir(projectPath, relativePath || undefined);
    dirEntries.set(result.entries);
    currentDir.set(result.resolvedPath);
    return result.entries;
}

/**
 * Open a file in the editor.
 */
export async function openFileInEditor(projectPath, relativePath) {
    const result = await window.api.files.read(projectPath, relativePath);
    openFile.set(result);
    savedContent.set(result.content);
    editorContent.set(result.content);
}

let autoSaveTimer = null;

/**
 * Save the current file to disk immediately.
 * Clears any pending auto-save timer so a debounced write doesn't double-fire.
 */
export async function saveFile(projectPath) {
    clearAutoSaveTimer();

    let currentContent;
    editorContent.subscribe(v => currentContent = v)();

    let currentFile;
    openFile.subscribe(v => currentFile = v)();

    if (!currentFile || currentContent === null) return;

    await window.api.files.write(projectPath, currentFile.path, currentContent);
    savedContent.set(currentContent);
}

/**
 * Schedule a debounced save (1 000 ms). Resets the timer on each call
 * so rapid keystrokes don't trigger multiple writes.
 */
export function scheduleAutoSave(projectPath) {
    clearAutoSaveTimer();
    autoSaveTimer = setTimeout(() => {
        autoSaveTimer = null;
        saveFile(projectPath);
    }, 1000);
}

function clearAutoSaveTimer() {
    if (autoSaveTimer) {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
    }
}

/**
 * Close the current file. Flushes any pending auto-save timer.
 */
export function closeFile() {
    clearAutoSaveTimer();
    openFile.set(null);
    savedContent.set(null);
    editorContent.set(null);
}
