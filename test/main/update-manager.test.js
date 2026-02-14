import { describe, it, expect, vi } from 'vitest';

// Mock electron
vi.mock('electron', () => import('../mocks/electron.js'));

// Mock electron-updater
vi.mock('electron-updater', () => ({
    autoUpdater: {
        checkForUpdates: vi.fn(),
        quitAndInstall: vi.fn(),
        autoDownload: false,
        autoInstallOnAppQuit: false,
        on: vi.fn(),
    }
}));

const { getUpdateStatus, checkForUpdates, installDownloadedUpdate, initAutoUpdater } = await import('../../main/update-manager.js');
const { autoUpdater } = await import('electron-updater');

describe('getUpdateStatus', () => {

    it('returns idle status by default', () => {
        const status = getUpdateStatus();
        // Before init, or in dev mode, state is idle or disabled
        expect(['idle', 'disabled']).toContain(status.state);
    });

    it('returns a copy (not the internal reference)', () => {
        const a = getUpdateStatus();
        const b = getUpdateStatus();
        a.state = 'MUTATED';
        expect(b.state).not.toBe('MUTATED');
    });
});

describe('checkForUpdates', () => {

    it('returns disabled state in dev mode (app.isPackaged = false)', async () => {
        const status = await checkForUpdates();
        expect(status.state).toBe('disabled');
        expect(status.message).toContain('development');
    });

    it('does NOT call autoUpdater.checkForUpdates in dev mode', async () => {
        await checkForUpdates();
        expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    });
});

describe('installDownloadedUpdate', () => {

    it('refuses to install when no update is downloaded', () => {
        const result = installDownloadedUpdate();
        expect(result.success).toBe(false);
        expect(result.reason).toBe('NO_DOWNLOADED_UPDATE');
    });
});

describe('initAutoUpdater', () => {

    it('accepts a window getter and is idempotent', () => {
        const getter = vi.fn(() => null);
        // In dev mode, init just sets state to disabled
        initAutoUpdater(getter);
        const status = getUpdateStatus();
        expect(status.state).toBe('disabled');

        // Second call shouldn't crash
        initAutoUpdater(getter);
    });
});
