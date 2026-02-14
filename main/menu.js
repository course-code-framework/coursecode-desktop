import { Menu, app, shell, BrowserWindow, ipcMain } from 'electron';

export function buildMenu() {
    const isMac = process.platform === 'darwin';

    const template = [
        ...(isMac ? [{
            label: app.name,
            submenu: [
                { role: 'about' },
                { type: 'separator' },
                {
                    label: 'Preferences',
                    accelerator: 'CmdOrCtrl+,',
                    click: () => {
                        const win = BrowserWindow.getFocusedWindow();
                        if (win) win.webContents.send('navigate', 'settings');
                    }
                },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' }
            ]
        }] : []),
        {
            label: 'File',
            submenu: [
                {
                    label: 'New Course',
                    accelerator: 'CmdOrCtrl+N',
                    click: () => {
                        const win = BrowserWindow.getFocusedWindow();
                        if (win) win.webContents.send('navigate', 'create');
                    }
                },
                {
                    label: 'New Chat',
                    accelerator: 'CmdOrCtrl+Shift+N',
                    click: () => {
                        const win = BrowserWindow.getFocusedWindow();
                        if (win) win.webContents.send('chat:newChat');
                    }
                },
                {
                    label: 'Open Projects Folder',
                    click: () => {
                        const { getSetting } = require('./settings.js');
                        shell.openPath(getSetting('projectsDir'));
                    }
                },
                ...(isMac ? [] : [
                    { type: 'separator' },
                    {
                        label: 'Settings',
                        accelerator: 'CmdOrCtrl+,',
                        click: () => {
                            const win = BrowserWindow.getFocusedWindow();
                            if (win) win.webContents.send('navigate', 'settings');
                        }
                    },
                    { type: 'separator' },
                    { role: 'quit' }
                ])
            ]
        },
        { role: 'editMenu' },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'forceReload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                {
                    label: 'Open Preview in Browser',
                    accelerator: 'CmdOrCtrl+Shift+P',
                    click: () => {
                        const win = BrowserWindow.getFocusedWindow();
                        if (win) win.webContents.send('open-preview-in-browser');
                    }
                },
                { type: 'separator' },
                { role: 'togglefullscreen' }
            ]
        },
        ...(isMac ? [{ role: 'windowMenu' }] : []),
        {
            label: 'Help',
            submenu: [
                {
                    label: 'Desktop Help',
                    click: () => shell.openExternal('https://coursecodedesktop.com/docs')
                },
                {
                    label: 'Framework Help',
                    click: () => shell.openExternal('https://coursecodeframework.com/docs')
                },
                {
                    label: 'Report Issue',
                    click: () => shell.openExternal('https://github.com/course-code-framework/coursecode-desktop/issues')
                },
                ...(isMac ? [] : [
                    { type: 'separator' },
                    { role: 'about' }
                ])
            ]
        }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}
