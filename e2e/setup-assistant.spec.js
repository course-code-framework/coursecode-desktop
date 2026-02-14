import { test, expect } from '@playwright/test';
import { launchApp, readSettings, cleanupTempDirs } from './helpers.js';

test.afterAll(cleanupTempDirs);

test.describe('Setup Assistant', () => {
    test('shows the Setup Assistant on first launch', async () => {
        const { app, window } = await launchApp({ freshInstall: true });

        // The Setup Assistant should be visible
        const setup = window.locator('[data-testid="setup-assistant"]');
        await expect(setup).toBeVisible();

        // The welcome step should be displayed
        await expect(window.locator('[data-testid="setup-welcome"]')).toBeVisible();
        await expect(window.locator('text=Welcome to CourseCode')).toBeVisible();

        // The sidebar nav should show all steps
        await expect(window.locator('[data-testid="setup-step-nav-welcome"]')).toBeVisible();
        await expect(window.locator('[data-testid="setup-step-nav-cli"]')).toBeVisible();
        await expect(window.locator('[data-testid="setup-step-nav-done"]')).toBeVisible();

        await app.close();
    });

    test('can select workflow preset on welcome step', async () => {
        const { app, window } = await launchApp({ freshInstall: true });
        await expect(window.locator('[data-testid="setup-welcome"]')).toBeVisible();

        // AI preset should be active by default
        const aiPreset = window.locator('[data-testid="preset-ai"]');
        await expect(aiPreset).toHaveClass(/active/);

        // Switch to GUI preset
        const guiPreset = window.locator('[data-testid="preset-gui"]');
        await guiPreset.click();
        await expect(guiPreset).toHaveClass(/active/);
        await expect(aiPreset).not.toHaveClass(/active/);

        await app.close();
    });

    test('can navigate through all steps via Skip', async () => {
        const { app, window } = await launchApp({ freshInstall: true });
        await expect(window.locator('[data-testid="setup-welcome"]')).toBeVisible();

        // Step 0 → 1: Click "Let's Go"
        await window.locator('[data-testid="setup-next-btn"]').click();
        await expect(window.locator('text=CourseCode Tools').first()).toBeVisible();

        // Step 1 → 2: Skip
        await window.locator('[data-testid="setup-skip-btn"]').click();
        await expect(window.locator('text=AI Assistant').first()).toBeVisible();

        // Step 2 → 3: Skip
        await window.locator('[data-testid="setup-skip-btn"]').click();
        await expect(window.locator('text=Code Editor').first()).toBeVisible();

        // Step 3 → 4: Skip
        await window.locator('[data-testid="setup-skip-btn"]').click();
        await expect(window.locator('text=Version Control').first()).toBeVisible();

        // Step 4 → 5: Skip
        await window.locator('[data-testid="setup-skip-btn"]').click();
        await expect(window.locator('text=Cloud Account').first()).toBeVisible();

        // Step 5 → 6: Skip
        await window.locator('[data-testid="setup-skip-btn"]').click();
        await expect(window.locator('[data-testid="setup-done"]')).toBeVisible();
        await expect(window.locator('text=You\'re All Set!').first()).toBeVisible();

        await app.close();
    });

    test('Back button navigates to previous step', async () => {
        const { app, window } = await launchApp({ freshInstall: true });
        await expect(window.locator('[data-testid="setup-welcome"]')).toBeVisible();

        // Advance to step 1
        await window.locator('[data-testid="setup-next-btn"]').click();
        await expect(window.locator('text=CourseCode Tools').first()).toBeVisible();

        // Go back to welcome
        await window.locator('[data-testid="setup-back-btn"]').click();
        await expect(window.locator('[data-testid="setup-welcome"]')).toBeVisible();

        await app.close();
    });

    test('completing setup navigates to Dashboard', async () => {
        const { app, window, userDataDir } = await launchApp({ freshInstall: true });
        await expect(window.locator('[data-testid="setup-welcome"]')).toBeVisible();

        // Skip through all steps
        await window.locator('[data-testid="setup-next-btn"]').click(); // Welcome → CLI
        for (let i = 0; i < 5; i++) {
            await window.locator('[data-testid="setup-skip-btn"]').click();
        }

        // Should be on the "All Set" step — click "Get Started"
        await expect(window.locator('[data-testid="setup-done"]')).toBeVisible();
        await window.locator('[data-testid="setup-finish-btn"]').click();

        // Should now see the Dashboard
        await expect(window.locator('[data-testid="dashboard"]')).toBeVisible();

        // Settings should have setupCompleted: true
        const settings = await readSettings(userDataDir);
        expect(settings.setupCompleted).toBe(true);

        await app.close();
    });

    test('reopening after completion skips the Setup Assistant', async () => {
        const { app, window, userDataDir } = await launchApp({ freshInstall: true });

        // Complete the wizard
        await window.locator('[data-testid="setup-next-btn"]').click();
        for (let i = 0; i < 5; i++) {
            await window.locator('[data-testid="setup-skip-btn"]').click();
        }
        await window.locator('[data-testid="setup-finish-btn"]').click();
        await expect(window.locator('[data-testid="dashboard"]')).toBeVisible();
        await app.close();

        // Relaunch with the same userData dir
        const { _electron: electron } = await import('@playwright/test');
        const { join } = await import('path');
        const app2 = await electron.launch({
            args: [join(process.cwd(), 'out/main/index.js')],
            env: { ...process.env, ELECTRON_USER_DATA_DIR: userDataDir, E2E_HEADLESS: 'true' }
        });
        const window2 = await app2.firstWindow();

        // Should go straight to Dashboard
        await expect(window2.locator('[data-testid="dashboard"]')).toBeVisible();
        await expect(window2.locator('[data-testid="setup-assistant"]')).not.toBeVisible();

        await app2.close();
    });
});
