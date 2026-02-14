import { _electron as electron } from '@playwright/test';
import { join } from 'path';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';

/** Track temp dirs for cleanup */
const tempDirs = [];

/**
 * Launch the Electron app with an isolated temp userData directory.
 * By default, pre-seeds settings so the Setup Assistant is skipped.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.freshInstall=false] - If true, do NOT set setupCompleted (shows Setup Assistant).
 * @param {object} [opts.settings] - Additional settings to merge into the seeded settings.json.
 * @returns {Promise<{ app: import('@playwright/test').ElectronApplication, window: import('@playwright/test').Page, userDataDir: string }>}
 */
export async function launchApp({ freshInstall = false, settings: extraSettings = {}, seedProject = false } = {}) {
    const userDataDir = await mkdtemp(join(tmpdir(), 'cc-e2e-'));
    tempDirs.push(userDataDir);

    if (!freshInstall) {
        const settings = {
            setupCompleted: true,
            projectsDir: join(userDataDir, 'projects'),
            theme: 'dark',
            ...extraSettings
        };
        await writeFile(join(userDataDir, 'settings.json'), JSON.stringify(settings));

        const projectsDir = join(userDataDir, 'projects');
        await mkdir(projectsDir, { recursive: true });

        if (seedProject) {
            const testProjectDir = join(projectsDir, 'test-course');
            await mkdir(testProjectDir, { recursive: true });

            // Minimal course-config to be detected by the dashboard
            const configContent = `export default { title: 'Test E2E Course', format: 'cmi5' };`;
            await writeFile(join(testProjectDir, 'course-config.js'), configContent);
        }
    }

    const app = await electron.launch({
        args: [join(process.cwd(), 'out/main/index.js')],
        env: {
            ...process.env,
            ELECTRON_USER_DATA_DIR: userDataDir,
            E2E_HEADLESS: 'true'
        }
    });

    const window = await app.firstWindow();
    window.on('console', msg => console.log('RENDERER:', msg.type(), msg.text()));
    window.on('pageerror', err => console.log('RENDERER EXCEPTION:', err));
    return { app, window, userDataDir };
}

/**
 * Read settings.json from the given userData directory.
 * @param {string} userDataDir
 * @returns {Promise<object>}
 */
export async function readSettings(userDataDir) {
    const { readFile } = await import('fs/promises');
    const raw = await readFile(join(userDataDir, 'settings.json'), 'utf8');
    return JSON.parse(raw);
}

/**
 * Clean up all temp directories created during the test run.
 * Call in afterAll or afterEach.
 */
export async function cleanupTempDirs() {
    for (const dir of tempDirs) {
        try {
            await rm(dir, { recursive: true, force: true });
        } catch { /* best-effort cleanup */ }
    }
    tempDirs.length = 0;
}
