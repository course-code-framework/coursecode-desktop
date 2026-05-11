import { test, expect } from '@playwright/test';
import { launchApp, cleanupTempDirs } from './helpers.js';

test.afterAll(cleanupTempDirs);

test.describe('Navigation & Tabs', () => {
    test('app container exposes data-view attribute', async () => {
        const { app, window } = await launchApp();

        const container = window.locator('[data-testid="app-container"]');
        await expect(container).toHaveAttribute('data-view', 'dashboard');

        await app.close();
    });

    test('data-view changes to settings when Settings is opened', async () => {
        const { app, window } = await launchApp();
        await window.locator('[data-testid="settings-btn"]').click();

        const container = window.locator('[data-testid="app-container"]');
        await expect(container).toHaveAttribute('data-view', 'settings');

        await app.close();
    });

    test('data-view changes to create when Create Wizard is opened', async () => {
        const { app, window } = await launchApp();
        await window.locator('[data-testid="new-course-btn"]').click();

        const container = window.locator('[data-testid="app-container"]');
        await expect(container).toHaveAttribute('data-view', 'create');

        await app.close();
    });

    test('home tab is present by default', async () => {
        const { app, window } = await launchApp();

        // The TabBar should show a home tab
        const homeTab = window.locator('.tab.home');
        await expect(homeTab).toBeVisible();

        await app.close();
    });

    test('macOS titlebar tab strip keeps empty space draggable', async () => {
        test.skip(process.platform !== 'darwin', 'macOS titlebar drag region only');

        const { app, window } = await launchApp();

        await expect(window.locator('.titlebar-drag')).toBeVisible();
        await expect(window.locator('.titlebar-drag .tab-bar')).toBeVisible();

        const regions = await window.evaluate(() => ({
            titlebarTabs: getComputedStyle(document.querySelector('.titlebar-tabs')).webkitAppRegion,
            tabBar: getComputedStyle(document.querySelector('.titlebar-drag .tab-bar')).webkitAppRegion,
            tab: getComputedStyle(document.querySelector('.titlebar-drag .tab')).webkitAppRegion,
            action: getComputedStyle(document.querySelector('.titlebar-drag .tab-action-btn')).webkitAppRegion
        }));

        expect(regions.titlebarTabs).not.toBe('no-drag');
        expect(regions.tabBar).toBe('drag');
        expect(regions.tab).toBe('no-drag');
        expect(regions.action).toBe('no-drag');

        await app.close();
    });


});
