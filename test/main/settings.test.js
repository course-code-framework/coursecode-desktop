import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { setUserDataDir } from '../mocks/electron.js';

// Mock electron before importing the module under test
vi.mock('electron', () => import('../mocks/electron.js'));

let tempDir;

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cc-settings-test-'));
    setUserDataDir(tempDir);
    // Re-import to get a clean module state
});

afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
});

// Dynamic import to pick up mock
const settingsMod = await import('../../main/settings.js');
const { loadSettings, getSetting, saveSetting, getAllSettings, isFirstLaunch } = settingsMod;

describe('settings', () => {

    describe('loadSettings', () => {

        it('uses defaults when no settings file exists', () => {
            loadSettings();
            expect(getSetting('defaultFormat')).toBe('cmi5');
            expect(getSetting('theme')).toBe('system');
            expect(getSetting('setupCompleted')).toBe(false);
        });

        it('merges saved settings with defaults', () => {
            const settingsPath = join(tempDir, 'settings.json');
            writeFileSync(settingsPath, JSON.stringify({
                theme: 'dark',
                defaultFormat: 'scorm2004'
            }));
            loadSettings();
            expect(getSetting('theme')).toBe('dark');
            expect(getSetting('defaultFormat')).toBe('scorm2004');
            // Defaults should fill in missing keys
            expect(getSetting('defaultLayout')).toBe('article');
        });

        it('falls back to defaults on corrupt JSON', () => {
            const settingsPath = join(tempDir, 'settings.json');
            writeFileSync(settingsPath, 'NOT VALID JSON {{{');
            loadSettings();
            expect(getSetting('defaultFormat')).toBe('cmi5');
        });

        it('drops leftover cloud AI mode settings', () => {
            const settingsPath = join(tempDir, 'settings.json');
            writeFileSync(settingsPath, JSON.stringify({
                aiProvider: 'openai',
                defaultAiMode: 'cloud',
                aiModeInitialized: true,
                cloudAiModel: 'claude-sonnet-4-5',
                cloudModelCache: [{ id: 'claude-sonnet-4-5' }]
            }));
            loadSettings();
            const all = getAllSettings();
            expect(all).not.toHaveProperty('defaultAiMode');
            expect(all).not.toHaveProperty('aiModeInitialized');
            expect(all).not.toHaveProperty('cloudAiModel');
            expect(all).not.toHaveProperty('cloudModelCache');
            expect(getSetting('aiProvider')).toBe('openai');
        });

        it('creates projects directory if it does not exist', () => {
            const projectsDir = join(tempDir, 'test-projects');
            const settingsPath = join(tempDir, 'settings.json');
            writeFileSync(settingsPath, JSON.stringify({ projectsDir }));
            loadSettings();
            expect(existsSync(projectsDir)).toBe(true);
        });
    });

    describe('getSetting', () => {

        it('returns default for unknown keys', () => {
            loadSettings();
            // A key that doesn't exist in DEFAULTS should return undefined
            expect(getSetting('nonExistentKey')).toBeUndefined();
        });
    });

    describe('saveSetting', () => {

        it('persists a setting to disk', () => {
            loadSettings();
            saveSetting('theme', 'dark');
            expect(getSetting('theme')).toBe('dark');

            // Verify it was written to disk
            const raw = readFileSync(join(tempDir, 'settings.json'), 'utf-8');
            const saved = JSON.parse(raw);
            expect(saved.theme).toBe('dark');
        });

        it('preserves other settings when saving one', () => {
            loadSettings();
            saveSetting('theme', 'dark');
            saveSetting('defaultFormat', 'lti');
            expect(getSetting('theme')).toBe('dark');
            expect(getSetting('defaultFormat')).toBe('lti');
        });
    });

    describe('getAllSettings', () => {

        it('returns a copy, not the internal reference', () => {
            loadSettings();
            const all = getAllSettings();
            all.theme = 'MUTATED';
            expect(getSetting('theme')).not.toBe('MUTATED');
        });
    });

    describe('isFirstLaunch', () => {

        it('returns true when setupCompleted is false', () => {
            loadSettings();
            expect(isFirstLaunch()).toBe(true);
        });

        it('returns false when setupCompleted is true', () => {
            const settingsPath = join(tempDir, 'settings.json');
            writeFileSync(settingsPath, JSON.stringify({ setupCompleted: true }));
            loadSettings();
            expect(isFirstLaunch()).toBe(false);
        });
    });
});
