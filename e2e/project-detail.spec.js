import { test, expect } from '@playwright/test';
import { launchApp, cleanupTempDirs } from './helpers.js';

test.afterAll(cleanupTempDirs);

test.describe('Project Detail View', () => {
    test('opens a project from the dashboard', async () => {
        const { app, window } = await launchApp({ seedProject: true });

        // Wait for dashboard and the seeded project card to appear
        await expect(window.locator('[data-testid="dashboard"]')).toBeVisible();

        // Click the project card to open it (the card itself or the course name)
        const courseCard = window.locator('.course-card').filter({ hasText: 'Test E2E Course' });
        await expect(courseCard).toBeVisible();
        await courseCard.locator('.card-title-btn').click();

        // Project detail view should mount
        await expect(window.locator('[data-testid="project-detail"]')).toBeVisible();

        // Titlebar should show the project title (in the TabBar, it's an active tab)
        const activeTab = window.locator('.tab.active');
        await expect(activeTab).toBeVisible();
        await expect(activeTab).toContainText('Test E2E Course');

        await app.close();
    });

    test('toolbar has expected action buttons', async () => {
        const { app, window } = await launchApp({ seedProject: true });
        await window.locator('.course-card').filter({ hasText: 'Test E2E Course' }).locator('.card-title-btn').click();
        await expect(window.locator('[data-testid="project-detail"]')).toBeVisible();

        // Check toolbar buttons
        await expect(window.locator('[data-testid="export-btn"]')).toBeVisible();
        await expect(window.locator('[data-testid="deploy-btn"]')).toBeVisible();
        await expect(window.locator('[data-testid="outline-btn"]')).toBeVisible();
        await expect(window.locator('[data-testid="history-btn"]')).toBeVisible();
        await expect(window.locator('[data-testid="chat-toggle-btn"]')).toBeVisible();

        await app.close();
    });

    test('deploy popover opens and closes', async () => {
        const { app, window } = await launchApp({ seedProject: true });
        await window.locator('.course-card').filter({ hasText: 'Test E2E Course' }).locator('.card-title-btn').click();

        // Click deploy to open popover
        await window.locator('[data-testid="deploy-btn"]').click();

        // Popover should be visible
        const popover = window.locator('.deploy-popover');
        await expect(popover).toBeVisible();

        // Click cancel to close it
        await window.locator('.deploy-popover-cancel').click();
        await expect(popover).not.toBeVisible();

        await app.close();
    });

    test('toggles between Preview and Editor tabs', async () => {
        const { app, window } = await launchApp({ seedProject: true });
        await window.locator('.course-card').filter({ hasText: 'Test E2E Course' }).locator('.card-title-btn').click();

        // By default, preview is selected
        const previewTabBtn = window.locator('[data-testid="tab-preview"]');
        const editorTabBtn = window.locator('[data-testid="tab-editor"]');

        await expect(previewTabBtn).toHaveClass(/active/);
        await expect(editorTabBtn).not.toHaveClass(/active/);

        // Click Editor tab
        await editorTabBtn.click();
        await expect(editorTabBtn).toHaveClass(/active/);
        await expect(previewTabBtn).not.toHaveClass(/active/);

        // The exact content might vary (monaco vs placeholder), 
        // but it should no longer be the preview iframe/placeholder
        await expect(window.locator('[data-testid="preview-placeholder"]')).not.toBeVisible();

        // Switch back to Preview
        await previewTabBtn.click();
        await expect(previewTabBtn).toHaveClass(/active/);

        await app.close();
    });
});
