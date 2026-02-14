import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { createLogger } from './logger.js';

const log = createLogger('updater');

let initialized = false;
let getMainWindow = () => null;
let status = {
    state: 'idle', // idle | disabled | checking | available | not-available | downloading | downloaded | error
    message: ''
};

function publishStatus(next, includeLegacy = false) {
    status = { ...status, ...next, checkedAt: new Date().toISOString() };

    const win = getMainWindow?.();
    if (!win || win.isDestroyed()) return;

    win.webContents.send('app:updateStatus', status);
    if (includeLegacy && status.state === 'available') {
        win.webContents.send('app:updateAvailable', status);
    }
}

export function getUpdateStatus() {
    return { ...status };
}

export async function checkForUpdates() {
    if (!app.isPackaged) {
        publishStatus({ state: 'disabled', message: 'Updates are disabled in development builds.' });
        return getUpdateStatus();
    }

    publishStatus({ state: 'checking', message: 'Checking for updates...' });
    try {
        await autoUpdater.checkForUpdates();
    } catch (err) {
        log.warn('Failed to check for updates', err);
        publishStatus({
            state: 'error',
            message: err?.message || 'Update check failed.'
        });
    }
    return getUpdateStatus();
}

export function installDownloadedUpdate() {
    if (status.state !== 'downloaded') {
        return { success: false, reason: 'NO_DOWNLOADED_UPDATE' };
    }
    autoUpdater.quitAndInstall(false, true);
    return { success: true };
}

export function initAutoUpdater(mainWindowGetter) {
    getMainWindow = mainWindowGetter;
    if (initialized) return;
    initialized = true;

    if (!app.isPackaged) {
        status = { state: 'disabled', message: 'Updates are disabled in development builds.' };
        return;
    }

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => {
        publishStatus({ state: 'checking', message: 'Checking for updates...' });
    });

    autoUpdater.on('update-available', (info) => {
        log.info('Update available', { version: info?.version });
        publishStatus({
            state: 'available',
            message: `Update ${info?.version || ''} is available.`,
            version: info?.version || null,
            releaseName: info?.releaseName || null,
            releaseDate: info?.releaseDate || null
        }, true);
    });

    autoUpdater.on('download-progress', (progress) => {
        publishStatus({
            state: 'downloading',
            message: `Downloading update (${Math.round(progress?.percent || 0)}%)...`,
            downloadPercent: progress?.percent || 0
        });
    });

    autoUpdater.on('update-downloaded', (info) => {
        log.info('Update downloaded', { version: info?.version });
        publishStatus({
            state: 'downloaded',
            message: 'Update downloaded. It will install when you quit the app.',
            version: info?.version || null,
            releaseName: info?.releaseName || null,
            releaseDate: info?.releaseDate || null,
            downloadPercent: 100
        });
    });

    autoUpdater.on('update-not-available', (info) => {
        publishStatus({
            state: 'not-available',
            message: 'You are up to date.',
            version: info?.version || app.getVersion()
        });
    });

    autoUpdater.on('error', (err) => {
        log.warn('Auto-updater error', err);
        publishStatus({
            state: 'error',
            message: err?.message || 'Auto-update failed.'
        });
    });
}
