import { test, expect } from '@playwright/test';
import { launchApp, cleanupTempDirs } from './helpers.js';

test.afterAll(cleanupTempDirs);

test.describe('Dashboard', () => {
    test('shows empty state when there are no projects', async () => {
        const { app, window } = await launchApp();

        await expect(window.locator('[data-testid="dashboard"]')).toBeVisible();

        // Should show the empty state CTA
        await expect(window.locator('text=Create Your First Course')).toBeVisible();
        await expect(window.locator('text=New Course').first()).toBeVisible();

        // Course list grid should not be visible with no projects
        await expect(window.locator('[data-testid="course-list"]')).not.toBeVisible();

        await app.close();
    });

    test('header elements are present', async () => {
        const { app, window } = await launchApp();

        await expect(window.locator('[data-testid="dashboard"]')).toBeVisible();

        // Logo and title
        await expect(window.locator('text=CourseCode').first()).toBeVisible();

        // New Course button
        await expect(window.locator('[data-testid="new-course-btn"]')).toBeVisible();

        await app.close();
    });

    test('empty state CTA opens Create Wizard', async () => {
        const { app, window } = await launchApp();
        await expect(window.locator('[data-testid="dashboard"]')).toBeVisible();

        // Click the empty state action button (has text "New Course")
        const ctaButton = window.locator('text=New Course').first();
        await ctaButton.click();

        // The Create Wizard should appear
        await expect(window.locator('[data-testid="create-wizard"]')).toBeVisible();

        await app.close();
    });

    test('search bar is present and accepts input', async () => {
        const { app, window } = await launchApp();
        await expect(window.locator('[data-testid="dashboard"]')).toBeVisible();

        const search = window.locator('.search-input');
        await expect(search).toBeVisible();
        await search.fill('test query');
        await expect(search).toHaveValue('test query');

        await app.close();
    });

    test('format filter dropdown is present', async () => {
        const { app, window } = await launchApp();
        await expect(window.locator('[data-testid="dashboard"]')).toBeVisible();

        const formatSelect = window.locator('.format-select');
        await expect(formatSelect).toBeVisible();

        // Should default to 'all'
        await expect(formatSelect).toHaveValue('all');

        await app.close();
    });

    test('sort dropdown is present and defaults to Last Modified', async () => {
        const { app, window } = await launchApp();
        await expect(window.locator('[data-testid="dashboard"]')).toBeVisible();

        const sortSelect = window.locator('.sort-select');
        await expect(sortSelect).toBeVisible();
        await expect(sortSelect).toHaveValue('modified');

        await app.close();
    });
});
