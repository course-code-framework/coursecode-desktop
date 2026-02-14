import { writable, derived, get } from 'svelte/store';

const MAX_TABS = 5;

/** All open tabs. Home tab is always first. */
export const tabs = writable([{ id: 'home', type: 'home', title: 'Courses' }]);

/** ID of the currently active tab. */
export const activeTabId = writable('home');

/** Derived: the active tab object. */
export const activeTab = derived([tabs, activeTabId], ([$tabs, $id]) =>
    $tabs.find(t => t.id === $id) || $tabs[0]
);

/** Open a course in a new tab (or focus existing). Returns false if at limit. */
export function openCourseTab(path, title) {
    const current = get(tabs);
    const existing = current.find(t => t.id === path);
    if (existing) {
        activeTabId.set(path);
        return true;
    }
    // Count non-home tabs
    const courseTabs = current.filter(t => t.type === 'course');
    if (courseTabs.length >= MAX_TABS) return false;

    tabs.update(t => [...t, { id: path, type: 'course', title, path }]);
    activeTabId.set(path);
    return true;
}

/** Close a tab by ID. Cannot close home tab. */
export function closeTab(id) {
    if (id === 'home') return;
    const current = get(tabs);
    const idx = current.findIndex(t => t.id === id);
    if (idx === -1) return;

    // If closing the active tab, switch to previous tab or home
    if (get(activeTabId) === id) {
        const nextIdx = idx > 0 ? idx - 1 : 0;
        activeTabId.set(current[nextIdx].id);
    }

    tabs.update(t => t.filter(tab => tab.id !== id));
    return id; // Return closed path for cleanup (server stop, etc.)
}

/** Set active tab. */
export function setActiveTab(id) {
    activeTabId.set(id);
}




