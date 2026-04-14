import { app, BrowserWindow, Menu, shell, nativeTheme, dialog } from 'electron';
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

    // Smart context menu — preview-aware with Mention, Edit Mode, Copy
    mainWindow.webContents.on('context-menu', (_event, params) => {
        const isPreviewFrame = /^https?:\/\/127\.0\.0\.1:\d+/.test(params.frameURL || '');
        const hasSelection = !!params.selectionText?.trim();
        const items = [];

        if (hasSelection) {
            items.push({
                label: 'Copy',
                accelerator: 'CmdOrCtrl+C',
                click: () => mainWindow.webContents.copy()
            });
        }
        items.push({
            label: 'Select All',
            accelerator: 'CmdOrCtrl+A',
            click: () => {
                if (isPreviewFrame) {
                    // Select all within the iframe frame
                    for (const frame of mainWindow.webContents.mainFrame.frames) {
                        if (frame.url === params.frameURL) {
                            frame.executeJavaScript('document.execCommand("selectAll")');
                            break;
                        }
                    }
                } else {
                    mainWindow.webContents.selectAll();
                }
            }
        });

        if (isPreviewFrame) {
            items.push({ type: 'separator' });

            if (hasSelection) {
                const selectionText = params.selectionText.trim();
                const truncated = selectionText.length > 30
                    ? selectionText.slice(0, 30) + '…'
                    : selectionText;
                items.push({
                    label: `Mention "${truncated}" in Chat`,
                    click: async () => {
                        // Resolve current slide via the preview server API
                        const portMatch = params.frameURL.match(/:([\d]+)/);
                        let slideId = null;
                        if (portMatch) {
                            // Find the project path for this port
                            const { getProjectForPort } = await import('./preview-manager.js');
                            const projectPath = getProjectForPort(Number(portMatch[1]));
                            if (projectPath) {
                                slideId = await getCurrentSlideId(projectPath);
                            }
                        }
                        mainWindow.webContents.send('preview:contextMention', {
                            text: selectionText,
                            slideId
                        });
                    }
                });
            }

            items.push({
                label: 'Toggle Edit Mode',
                click: () => {
                    for (const frame of mainWindow.webContents.mainFrame.frames) {
                        if (frame.url === params.frameURL) {
                            // The preview iframe embeds a stub-player that has its own
                            // course iframe. The edit mode button lives on the stub-player
                            // (the top-level document of the preview frame).
                            frame.executeJavaScript(
                                'document.getElementById("stub-player-edit-mode-btn")?.click()'
                            );
                            break;
                        }
                    }
                }
            });

            items.push({ type: 'separator' });
            items.push({
                label: 'Open Preview in Browser',
                click: () => {
                    const previewOrigin = params.frameURL.match(/^https?:\/\/127\.0\.0\.1:\d+/);
                    if (previewOrigin) shell.openExternal(previewOrigin[0]);
                }
            });
        }

        if (items.length > 0) {
            Menu.buildFromTemplate(items).popup({ window: mainWindow });
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
