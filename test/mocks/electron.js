/**
 * Mock for the 'electron' module used by main process modules.
 * Provides stubs for app, shell, ipcMain, safeStorage, etc.
 */

import { vi } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync } from 'fs';

/** Create an isolated temp dir for each test suite that needs userData */
export function createTempUserData() {
    return mkdtempSync(join(tmpdir(), 'cc-test-'));
}

let _userDataDir = null;

export function setUserDataDir(dir) {
    _userDataDir = dir;
}

export const app = {
    isPackaged: false,
    getPath: vi.fn((name) => {
        if (name === 'userData') {
            return _userDataDir || join(tmpdir(), 'cc-test-default');
        }
        return join(tmpdir(), name);
    }),
    on: vi.fn(),
    quit: vi.fn(),
    getName: vi.fn(() => 'coursecode-desktop'),
    getVersion: vi.fn(() => '0.9.0'),
};

export const shell = {
    openExternal: vi.fn(),
    showItemInFolder: vi.fn(),
    trashItem: vi.fn(async () => { }),
};

export const ipcMain = {
    handle: vi.fn(),
    on: vi.fn(),
};

export const safeStorage = {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s) => Buffer.from(s)),
    decryptString: vi.fn((b) => b.toString()),
};

export const nativeTheme = {
    themeSource: 'system',
    shouldUseDarkColors: false,
};
