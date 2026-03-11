import { writable, derived } from 'svelte/store';

/** Current cloud user or null. */
export const user = writable(null);

/** Whether the user is authenticated and cloud features are available. */
export const cloudReady = derived(user, $user => $user != null);

/** Whether auth state is loading. */
export const authLoading = writable(true);

/** Last login error, if any. */
export const loginError = writable(null);

/** Load current cloud user. */
let _loadPromise = null;
export async function loadCloudUser() {
    if (_loadPromise) return _loadPromise;
    _loadPromise = (async () => {
        authLoading.set(true);
        try {
            const u = await window.api.cloud.getUser();
            user.set(u);
            return u;
        } catch {
            user.set(null);
            return null;
        } finally {
            authLoading.set(false);
            _loadPromise = null;
        }
    })();
    return _loadPromise;
}

/** Initiate login. */
export async function login() {
    loginError.set(null);
    try {
        await window.api.cloud.login();
        return await loadCloudUser();
    } catch (err) {
        loginError.set(err);
        throw err;
    }
}

/** Log out. */
export async function logout() {
    await window.api.cloud.logout();
    user.set(null);
}
