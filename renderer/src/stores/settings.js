import { writable } from 'svelte/store';
import { showToast } from './toast.js';

/** All settings from main process. */
export const settings = writable({});

/** Load settings from main process. */
export async function loadSettings() {
    try {
        const s = await window.api.settings.get();
        settings.set(s);
    } catch (err) {
        showToast({ type: 'error', message: 'Failed to load settings.' });
    }
}

/** Update a single setting. */
export async function updateSetting(key, value) {
    await window.api.settings.set(key, value);
    settings.update(s => ({ ...s, [key]: value }));
}
