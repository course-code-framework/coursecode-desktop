import { test, expect } from '@playwright/test';
import { launchApp, cleanupTempDirs } from './helpers.js';

test.afterAll(cleanupTempDirs);

test.describe('Create Wizard', () => {
    test('opens when clicking New Course on Dashboard', async () => {
        const { app, window } = await launchApp();

        await expect(window.locator('[data-testid="dashboard"]')).toBeVisible();
        await window.locator('[data-testid="new-course-btn"]').click();

        // The Create Wizard overlay should appear
        await expect(window.locator('[data-testid="create-wizard"]')).toBeVisible();
        await expect(window.locator('[data-testid="wizard-step-1"]')).toBeVisible();

        await app.close();
    });

    test('step 1: Continue is disabled when name is empty', async () => {
        const { app, window } = await launchApp();
        await window.locator('[data-testid="new-course-btn"]').click();
        await expect(window.locator('[data-testid="wizard-step-1"]')).toBeVisible();

        // Continue button should be disabled with no name
        const continueBtn = window.locator('[data-testid="wizard-continue-btn"]');
        await expect(continueBtn).toBeDisabled();

        await app.close();
    });

    test('step 1: Continue enables after typing a valid name', async () => {
        const { app, window } = await launchApp();
        await window.locator('[data-testid="new-course-btn"]').click();

        const nameInput = window.locator('[data-testid="course-name-input"]');
        await nameInput.fill('Test Course');

        const continueBtn = window.locator('[data-testid="wizard-continue-btn"]');
        await expect(continueBtn).toBeEnabled();

        await app.close();
    });

    test('can navigate through all 3 steps', async () => {
        const { app, window } = await launchApp();
        await window.locator('[data-testid="new-course-btn"]').click();

        // Step 1: Name
        await expect(window.locator('[data-testid="wizard-step-1"]')).toBeVisible();
        await window.locator('[data-testid="course-name-input"]').fill('Navigation Test');
        await window.locator('[data-testid="wizard-continue-btn"]').click();

        // Step 2: Format — should show format radio cards
        await expect(window.locator('[data-testid="wizard-step-2"]')).toBeVisible();
        await expect(window.locator('[data-testid="format-cmi5"]')).toBeVisible();
        await expect(window.locator('[data-testid="format-scorm2004"]')).toBeVisible();
        await expect(window.locator('[data-testid="format-scorm1.2"]')).toBeVisible();
        await expect(window.locator('[data-testid="format-lti"]')).toBeVisible();
        await window.locator('[data-testid="wizard-continue-btn"]').click();

        // Step 3: Layout — should show layout cards
        await expect(window.locator('[data-testid="wizard-step-3"]')).toBeVisible();
        await expect(window.locator('[data-testid="layout-article"]')).toBeVisible();

        await app.close();
    });

    test('Back button returns to previous steps', async () => {
        const { app, window } = await launchApp();
        await window.locator('[data-testid="new-course-btn"]').click();

        // Go to step 2
        await window.locator('[data-testid="course-name-input"]').fill('Back Test');
        await window.locator('[data-testid="wizard-continue-btn"]').click();
        await expect(window.locator('[data-testid="wizard-step-2"]')).toBeVisible();

        // Back to step 1
        await window.locator('[data-testid="wizard-back-btn"]').click();
        await expect(window.locator('[data-testid="wizard-step-1"]')).toBeVisible();

        // Name should be preserved
        await expect(window.locator('[data-testid="course-name-input"]')).toHaveValue('Back Test');

        await app.close();
    });

    test('close button dismisses the wizard', async () => {
        const { app, window } = await launchApp();
        await window.locator('[data-testid="new-course-btn"]').click();
        await expect(window.locator('[data-testid="create-wizard"]')).toBeVisible();

        await window.locator('[data-testid="wizard-close-btn"]').click();

        // Wizard should be gone, dashboard still visible
        await expect(window.locator('[data-testid="create-wizard"]')).not.toBeVisible();
        await expect(window.locator('[data-testid="dashboard"]')).toBeVisible();

        await app.close();
    });

    test('step 2: can select a format', async () => {
        const { app, window } = await launchApp();
        await window.locator('[data-testid="new-course-btn"]').click();

        await window.locator('[data-testid="course-name-input"]').fill('Format Test');
        await window.locator('[data-testid="wizard-continue-btn"]').click();

        // cmi5 should be selected by default
        await expect(window.locator('[data-testid="format-cmi5"]')).toHaveClass(/selected/);

        // Select SCORM 2004
        await window.locator('[data-testid="format-scorm2004"]').click();
        await expect(window.locator('[data-testid="format-scorm2004"]')).toHaveClass(/selected/);

        await app.close();
    });
});
