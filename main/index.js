import { app, BrowserWindow, ipcMain, shell, nativeTheme, dialog } from 'electron';
import { join } from 'path';
import { is } from '@electron-toolkit/utils';
import { registerIpcHandlers } from './ipc-handlers.js';
import { loadSettings, getSetting, saveSetting } from './settings.js';
import { buildMenu } from './menu.js';
import { createLogger } from './logger.js';
import { initAutoUpdater, checkForUpdates } from './update-manager.js';
import { injectSystemCerts } from './cloud-certs.js';
import { killAllPreviews } from './preview-manager.js';
import { getCurrentSlideId } from './mcp-client.js';

const log = createLogger('app');
const iconPath = join(__dirname, `../../build/${process.platform === 'win32' ? 'icon.ico' : 'icon.png'}`);

// Allow e2e tests to override userData dir for isolation
if (process.env.ELECTRON_USER_DATA_DIR) {
    app.setPath('userData', process.env.ELECTRON_USER_DATA_DIR);
}

let mainWindow = null;

function createWindow() {
    const bounds = getSetting('windowBounds') || {};

    mainWindow = new BrowserWindow({
        width: bounds.width || 1440,
        height: bounds.height || 900,
        x: bounds.x,
        y: bounds.y,
        minWidth: 1024,
        minHeight: 640,
        icon: iconPath,
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
        trafficLightPosition: { x: 16, y: 12 },
        backgroundColor: '#0f0f1a',
        show: false,
        webPreferences: {
            preload: join(__dirname, '../preload/index.js'),
            sandbox: false,
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    // Apply theme
    const theme = getSetting('theme') || 'system';
    nativeTheme.themeSource = theme;

    mainWindow.on('ready-to-show', () => {
        if (!process.env.E2E_HEADLESS) {
            mainWindow.show();
        }
    });

    // Save window bounds on move/resize
    let boundsTimer;
    const saveBounds = () => {
        clearTimeout(boundsTimer);
        boundsTimer = setTimeout(() => {
            if (!mainWindow.isDestroyed()) {
                saveSetting('windowBounds', mainWindow.getBounds());
            }
        }, 500);
    };
    mainWindow.on('resize', saveBounds);
    mainWindow.on('move', saveBounds);

    // Open external links in browser
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    // Smart context menu — sends context data to renderer for a custom styled menu.
    // Frame-level actions (select all, toggle edit mode) are handled via dedicated
    // IPC handlers since they require executeJavaScript on the preview frame.
    mainWindow.webContents.on('context-menu', async (_event, params) => {
        const isPreviewFrame = /^https?:\/\/127\.0\.0\.1:\d+/.test(params.frameURL || '');
        const selectionText = params.selectionText?.trim() || '';

        // Resolve current slide if right-clicking in the preview
        let slideId = null;
        if (isPreviewFrame) {
            const portMatch = params.frameURL.match(/:(\d+)/);
            if (portMatch) {
                const { getProjectForPort } = await import('./preview-manager.js');
                const projectPath = getProjectForPort(Number(portMatch[1]));
                if (projectPath) {
                    slideId = await getCurrentSlideId(projectPath);
                }
            }
        }

        mainWindow.webContents.send('preview:contextMenu', {
            x: params.x,
            y: params.y,
            selectionText,
            isPreviewFrame,
            slideId,
            frameURL: params.frameURL || ''
        });
    });

    // IPC handlers for preview frame actions (require executeJavaScript on the frame)
    ipcMain.handle('preview:selectAll', (_e, frameURL) => {
        // The course content is a nested iframe (grandchild of mainFrame),
        // so use framesInSubtree for recursive lookup.
        for (const frame of mainWindow.webContents.mainFrame.framesInSubtree) {
            if (frame.url === frameURL) {
                frame.executeJavaScript('document.execCommand("selectAll")');
                break;
            }
        }
    });

    ipcMain.handle('preview:toggleEditMode', (_e, port) => {
        // The edit-mode button lives in the stub player's top-level document
        // (direct child frame at the preview server root).
        const target = `http://127.0.0.1:${port}`;
        for (const frame of mainWindow.webContents.mainFrame.frames) {
            if (frame.url.startsWith(target)) {
                frame.executeJavaScript(
                    'document.getElementById("stub-player-edit-mode-btn")?.click()'
                );
                break;
            }
        }
    });

    // Load renderer
    if (is.dev && process.env.ELECTRON_RENDERER_URL) {
        mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
        mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
    }
}

app.whenReady().then(async () => {
    // Inject OS system CAs before any HTTPS calls (LLM providers, cloud, updater).
    // Corporate proxies (Zscaler, Netskope) use custom CAs that Node doesn't trust.
    await injectSystemCerts();

    log.info('App ready', { version: app.getVersion(), packaged: app.isPackaged });
    loadSettings();
    registerIpcHandlers();

    // Set dock icon on macOS (in dev mode there's no .app bundle)
    if (process.platform === 'darwin' && app.dock) {
        if (process.env.E2E_HEADLESS) {
            app.dock.hide();
        } else {
            app.dock.setIcon(iconPath);
        }
    }

    buildMenu(mainWindow);
    createWindow();
    initAutoUpdater(() => mainWindow);
    void checkForUpdates();

    app.on('activate', () => {
        log.debug('Activate event — recreating window');
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    log.info('All windows closed — quitting');
    app.quit();
});

app.on('before-quit', () => {
    log.info('Before quit — killing preview servers');
    killAllPreviews();
});

// --- Global error handlers ---

process.on('unhandledRejection', (reason) => {
    log.error('Unhandled promise rejection', reason instanceof Error ? reason : new Error(String(reason)));
    if (app.isPackaged) {
        dialog.showErrorBox('Unexpected Error', 'Something went wrong. Check logs for details.');
    }
});

process.on('uncaughtException', (err) => {
    log.error('Uncaught exception', err);
    if (app.isPackaged) {
        dialog.showErrorBox('Unexpected Error', 'Something went wrong. The app may need to restart.');
    }
});

// Handle terminal kill signals (Ctrl+C)
process.on('SIGINT', () => {
    log.info('SIGINT received — shutting down');
    killAllPreviews();
    app.quit();
    process.exit(0);
});

process.on('SIGTERM', () => {
    log.info('SIGTERM received — shutting down');
    killAllPreviews();
    app.quit();
    process.exit(0);
});
