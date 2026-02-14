import { test, expect } from '@playwright/test';
import { launchApp, readSettings, cleanupTempDirs } from './helpers.js';

test.afterAll(cleanupTempDirs);

test.describe('Settings', () => {
    test('opens from the TabBar settings button', async () => {
        const { app, window } = await launchApp();
        await expect(window.locator('[data-testid="dashboard"]')).toBeVisible();

        await window.locator('[data-testid="settings-btn"]').click();

        await expect(window.locator('[data-testid="settings"]')).toBeVisible();
        await expect(window.locator('text=Settings').first()).toBeVisible();

        await app.close();
    });

    test('back button returns to Dashboard', async () => {
        const { app, window } = await launchApp();
        await window.locator('[data-testid="settings-btn"]').click();
        await expect(window.locator('[data-testid="settings"]')).toBeVisible();

        await window.locator('[data-testid="settings-back-btn"]').click();

        await expect(window.locator('[data-testid="dashboard"]')).toBeVisible();

        await app.close();
    });

    test('shows all settings sections', async () => {
        const { app, window } = await launchApp();
        await window.locator('[data-testid="settings-btn"]').click();
        await expect(window.locator('[data-testid="settings"]')).toBeVisible();

        // Verify key section headings exist
        await expect(window.locator('text=General').first()).toBeVisible();
        await expect(window.locator('text=Appearance').first()).toBeVisible();
        await expect(window.locator('text=Tools & Integrations')).toBeVisible();
        await expect(window.locator('text=AI Assistant').first()).toBeVisible();
        await expect(window.locator('text=Cloud Account')).toBeVisible();
        await expect(window.locator('text=About')).toBeVisible();

        await app.close();
    });

    test('theme buttons switch the theme', async () => {
        const { app, window, userDataDir } = await launchApp();
        await window.locator('[data-testid="settings-btn"]').click();
        await expect(window.locator('[data-testid="settings"]')).toBeVisible();

        // Click Light theme button
        await window.locator('[data-testid="theme-btn-light"]').click();
        // The HTML root should get data-theme="light"
        const theme = await window.locator('html').getAttribute('data-theme');
        expect(theme).toBe('light');

        // Check it persisted
        const settings = await readSettings(userDataDir);
        expect(settings.theme).toBe('light');

        // Switch to dark
        await window.locator('[data-testid="theme-btn-dark"]').click();
        const darkTheme = await window.locator('html').getAttribute('data-theme');
        expect(darkTheme).toBe('dark');

        await app.close();
    });

    test('theme toggle cycles through modes', async () => {
        const { app, window } = await launchApp({ settings: { theme: 'system' } });
        await expect(window.locator('[data-testid="dashboard"]')).toBeVisible();

        // TabBar's theme toggle button should be visible
        const toggleBtn = window.locator('[data-testid="theme-toggle-btn"]');
        await expect(toggleBtn).toBeVisible();

        // Clicking cycles: system → light → dark → system
        await toggleBtn.click();
        let themeAttr = await window.locator('html').getAttribute('data-theme');
        expect(themeAttr).toBe('light');

        await toggleBtn.click();
        themeAttr = await window.locator('html').getAttribute('data-theme');
        expect(themeAttr).toBe('dark');

        await toggleBtn.click();
        // system — resolves to light or dark depending on OS, just check it changed back
        themeAttr = await window.locator('html').getAttribute('data-theme');
        expect(['light', 'dark']).toContain(themeAttr);

        await app.close();
    });

    test('projects directory is displayed', async () => {
        const { app, window, userDataDir } = await launchApp();
        await window.locator('[data-testid="settings-btn"]').click();
        await expect(window.locator('[data-testid="settings"]')).toBeVisible();

        // Projects directory input should show the configured path
        const pathInput = window.locator('.path-input');
        await expect(pathInput).toBeVisible();

        const value = await pathInput.inputValue();
        expect(value).toContain(userDataDir);

        await app.close();
    });

    test('shows app version in About section', async () => {
        const { app, window } = await launchApp();
        await window.locator('[data-testid="settings-btn"]').click();

        // Scroll to about section if needed
        const aboutSection = window.locator('text=CourseCode Desktop v');
        await expect(aboutSection).toBeVisible();

        await app.close();
    });

    test('cloud sign-in button is shown when not authenticated', async () => {
        const { app, window } = await launchApp();
        await window.locator('[data-testid="settings-btn"]').click();

        const signInBtn = window.locator('text=Sign In to CourseCode Cloud');
        await expect(signInBtn).toBeVisible();

        await app.close();
    });
});
