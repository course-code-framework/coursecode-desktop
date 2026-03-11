import { app } from 'electron';
import { join } from 'path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { createLogger } from './logger.js';

const log = createLogger('settings');

function getSettingsPath() {
    return join(app.getPath('userData'), 'settings.json');
}

const DEFAULTS = {
    projectsDir: join(homedir(), 'CourseCode Projects'),
    defaultFormat: 'cmi5',
    defaultLayout: 'article',
    showAiChatByDefault: true,
    keepPreviewRunningWithoutTab: false,
    previewPorts: {},
    theme: 'system',
    windowBounds: { width: 1200, height: 800 },
    setupCompleted: false,
    lastSetupStep: 0,
    cliVersion: null,
    aiProvider: 'anthropic',
    aiModel: null,
    aiCustomInstructions: '',
    defaultAiMode: 'byok',
    aiModeInitialized: false,
    cloudAiModel: null,
    cloudModelCache: []
};

let settings = { ...DEFAULTS };

/** Load settings from disk, merging with defaults. */
export function loadSettings() {
    try {
        if (existsSync(getSettingsPath())) {
            const raw = readFileSync(getSettingsPath(), 'utf-8');
            const saved = JSON.parse(raw);
            settings = { ...DEFAULTS, ...saved };
        }
    } catch (err) {
        log.warn('Failed to load settings, using defaults', err);
        settings = { ...DEFAULTS };
    }

    // Ensure projects directory exists
    if (!existsSync(settings.projectsDir)) {
        mkdirSync(settings.projectsDir, { recursive: true });
    }
}

/** Save current settings to disk. */
function persistSettings() {
    try {
        const dir = app.getPath('userData');
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2));
    } catch (err) {
        log.error('Failed to save settings', err);
    }
}

/** Get a single setting value. */
export function getSetting(key) {
    return settings[key] ?? DEFAULTS[key];
}

/** Set a single setting value and persist. */
export function saveSetting(key, value) {
    settings[key] = value;
    persistSettings();
}

/** Get all settings. */
export function getAllSettings() {
    return { ...settings };
}

/** Check if this is the first launch (setup not completed). */
export function isFirstLaunch() {
    return !settings.setupCompleted;
}
