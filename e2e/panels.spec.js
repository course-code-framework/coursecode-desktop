import { test, expect } from '@playwright/test';
import { launchApp, cleanupTempDirs } from './helpers.js';

test.afterAll(cleanupTempDirs);

test.describe('Workspace Panels', () => {
    test('chat panel can be toggled via toolbar', async () => {
        const { app, window } = await launchApp({ seedProject: true });
        await window.locator('.course-card').filter({ hasText: 'Test E2E Course' }).locator('.card-title-btn').click();


        // Chat should be visible by default (based on settings)
        await expect(window.locator('[data-testid="chat-panel"]')).toBeVisible();

        // Click toggle to hide it
        await window.locator('[data-testid="chat-toggle-btn"]').click();
        await expect(window.locator('[data-testid="chat-panel"]')).not.toBeVisible();

        // Click toggle to show it again
        await window.locator('[data-testid="chat-toggle-btn"]').click();
        await expect(window.locator('[data-testid="chat-panel"]')).toBeVisible();

        await app.close();
    });

    test('can open and close the outline panel', async () => {
        const { app, window } = await launchApp({ seedProject: true });
        await window.locator('.course-card').filter({ hasText: 'Test E2E Course' }).locator('.card-title-btn').click();

        // Outline is hidden by default
        await expect(window.locator('[data-testid="outline-panel"]')).not.toBeVisible();

        // Open outline from toolbar
        await window.locator('[data-testid="outline-btn"]').click();
        await expect(window.locator('[data-testid="outline-panel"]')).toBeVisible();

        // Close outline via its close button
        await window.locator('[data-testid="outline-panel"] .btn-ghost').click();
        await expect(window.locator('[data-testid="outline-panel"]')).not.toBeVisible();

        await app.close();
    });

    test('can open and close the history panel', async () => {
        const { app, window } = await launchApp({ seedProject: true });
        await window.locator('.course-card').filter({ hasText: 'Test E2E Course' }).locator('.card-title-btn').click();

        // History is hidden by default
        await expect(window.locator('[data-testid="history-panel"]')).not.toBeVisible();

        // Open history from toolbar
        await window.locator('[data-testid="history-btn"]').click();
        await expect(window.locator('[data-testid="history-panel"]')).toBeVisible();

        // Close history via its close button
        await window.locator('[data-testid="history-panel"] .btn-ghost').click();
        await expect(window.locator('[data-testid="history-panel"]')).not.toBeVisible();

        await app.close();
    });

    test('can expand the references panel', async () => {
        const { app, window } = await launchApp({ seedProject: true });
        await window.locator('.course-card').filter({ hasText: 'Test E2E Course' }).locator('.card-title-btn').click();

        // Refs list is hidden by default (only the toggle is visible)
        await expect(window.locator('[data-testid="refs-panel"]')).not.toBeVisible();

        // Click to expand refs
        await window.locator('.refs-toggle').click();

        // Refs panel should appear
        await expect(window.locator('[data-testid="refs-panel"]')).toBeVisible();

        await app.close();
    });
});
