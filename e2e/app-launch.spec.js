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
