import { writable, derived } from 'svelte/store';

/** Current cloud user or null. */
export const user = writable(null);

/** Whether the user is authenticated and cloud features are available. */
export const cloudReady = derived(user, $user => $user != null);

/** Whether auth state is loading. */
export const authLoading = writable(true);

/** Load current cloud user. */
export async function loadCloudUser() {
    authLoading.set(true);
    try {
        const u = await window.api.cloud.getUser();
        user.set(u);
    } catch {
        user.set(null);
    } finally {
        authLoading.set(false);
    }
}

/** Initiate login. */
export async function login() {
    await window.api.cloud.login();
    await loadCloudUser();
}

/** Log out. */
export async function logout() {
    await window.api.cloud.logout();
    user.set(null);
}
