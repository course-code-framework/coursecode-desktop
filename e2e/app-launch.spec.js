import { test, expect } from '@playwright/test';
import { launchApp, cleanupTempDirs } from './helpers.js';

test.afterAll(cleanupTempDirs);

test('app launches and shows dashboard', async () => {
    const { app, window } = await launchApp();

    // The app container should render with the dashboard view
    const container = window.locator('[data-testid="app-container"]');
    await expect(container).toBeVisible();
    await expect(container).toHaveAttribute('data-view', 'dashboard');

    // Dashboard should be present
    await expect(window.locator('[data-testid="dashboard"]')).toBeVisible();

    // Core header elements should exist
    await expect(window.locator('text=CourseCode').first()).toBeVisible();
    await expect(window.locator('[data-testid="new-course-btn"]')).toBeVisible();

    await app.close();
});

test('reopens its window from the dock after the last macOS window closes', async () => {
    test.skip(process.platform !== 'darwin');

    const { app } = await launchApp();
    const reopenedWindow = app.waitForEvent('window');

    await app.evaluate(({ app: electronApp, BrowserWindow }) => new Promise((resolve) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.once('closed', () => {
            electronApp.emit('activate');
            resolve();
        });
        window.close();
    }));

    const window = await reopenedWindow;
    await expect(window.locator('[data-testid="app-container"]')).toBeVisible();
    await expect(window.locator('[data-testid="dashboard"]')).toBeVisible();

    await app.close();
});
