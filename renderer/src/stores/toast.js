import { writable, derived } from 'svelte/store';

/** @typedef {{ id: string, type: 'success'|'error'|'info'|'warning', message: string, action?: { label: string, handler: () => void }, autoDismiss?: boolean, duration?: number }} Toast */

const _toasts = writable([]);

export const toasts = { subscribe: _toasts.subscribe };

let nextId = 0;

/**
 * Show a toast notification.
 * @param {{ type?: string, message: string, action?: { label: string, handler: () => void }, duration?: number }} opts
 * @returns {string} toast ID for manual dismissal
 */
export function showToast({ type = 'info', message, action, duration = 5000 }) {
    const id = `toast-${++nextId}`;
    const toast = { id, type, message, action, autoDismiss: !action, duration };
    _toasts.update(t => [...t, toast]);

    if (duration > 0) {
        setTimeout(() => dismissToast(id), duration);
    }

    return id;
}

/** Dismiss a specific toast. */
export function dismissToast(id) {
    _toasts.update(t => t.filter(toast => toast.id !== id));
}

/** Dismiss all toasts. */
export function dismissAll() {
    _toasts.set([]);
}
