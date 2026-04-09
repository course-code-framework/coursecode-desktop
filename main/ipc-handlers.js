import { ipcMain, app, shell, dialog } from 'electron';
import { getAllSettings, saveSetting } from './settings.js';
import { scanProjects, createProject, openProject, deleteProject, clearCloudBinding } from './project-manager.js';
import { startPreview, stopPreview, getPreviewStatus, getPreviewPort, getAllPreviewStatuses } from './preview-manager.js';
import { exportBuild } from './build-manager.js';
import { cloudLogin, cloudLogout, getCloudUser, cloudDeploy, getDeployStatus, updatePreviewLink } from './cloud-client.js';
import { getSetupStatus, installCLI, getDownloadUrl } from './cli-installer.js';
import {
    sendMessage, stopGeneration, clearConversation, loadHistory,
    buildMentionIndex, summarizeContext, getContextMemory,
    getSessionContext, resetConversationCache, resolveToolApproval
} from './chat-engine.js';
import { listRefs, readRef, convertRef } from './ref-manager.js';
import { getProviders, saveApiKey, removeApiKey, hasApiKey, getCloudModels, getCloudUsage } from './llm-provider.js';
import { loadToken } from './cloud-client.js';
import { listSnapshots, createSnapshot, restoreSnapshot, getChanges, diffSnapshot, diffSnapshotFile, applySnapshotFileVersion, hasRepo } from './snapshot-manager.js';
import { runWorkflow, cancelWorkflow } from './workflow-runner.js';
import { readProjectFile, writeProjectFile, listDirectory } from './file-manager.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { wrapIpcHandler } from './errors.js';
import { createLogger } from './logger.js';
import { checkForUpdates, getUpdateStatus, installDownloadedUpdate } from './update-manager.js';

const log = createLogger('ipc');

/**
 * Helper to register a wrapped IPC handler.
 * Every handler gets automatic error logging + user-friendly translation.
 */
function handle(channel, fn) {
    ipcMain.handle(channel, wrapIpcHandler(channel, fn));
}

export function registerIpcHandlers() {
    // --- Projects ---
    handle('projects:scan', () => scanProjects());
    handle('projects:create', (_e, options) => createProject(options));
    handle('projects:open', (_e, projectPath) => openProject(projectPath));
    handle('projects:reveal', (_e, projectPath) => {
        shell.showItemInFolder(projectPath);
    });
    handle('projects:delete', (_e, projectPath, options) => deleteProject(projectPath, options));
    handle('projects:clearCloudBinding', (_e, projectPath) => clearCloudBinding(projectPath));

    // --- Preview ---
    handle('preview:start', (e, projectPath, opts) => startPreview(projectPath, e.sender, opts));
    handle('preview:stop', (_e, projectPath) => stopPreview(projectPath));
    handle('preview:status', (_e, projectPath) => getPreviewStatus(projectPath));
    handle('preview:port', (_e, projectPath) => getPreviewPort(projectPath));
    handle('preview:statusAll', () => getAllPreviewStatuses());

    // --- Build ---
    handle('build:export', (e, projectPath, format, savePath) => exportBuild(projectPath, format, savePath, e.sender));

    // --- Cloud ---
    handle('cloud:login', (e) => cloudLogin(e.sender));
    handle('cloud:logout', () => cloudLogout());
    handle('cloud:getUser', () => getCloudUser());
    handle('cloud:deploy', (e, projectPath, options) => cloudDeploy(projectPath, e.sender, options));
    handle('cloud:getDeployStatus', (_e, projectPath, options) => getDeployStatus(projectPath, options));
    handle('cloud:updatePreviewLink', (_e, projectPath, options) => updatePreviewLink(projectPath, options));

    // --- Settings ---
    handle('settings:get', () => getAllSettings());
    handle('settings:set', (_e, key, value) => saveSetting(key, value));

    // --- Setup & Tools ---
    handle('setup:getStatus', () => getSetupStatus());
    handle('setup:installCLI', (e) => installCLI(e.sender));
    handle('setup:openDownloadPage', (_e, tool) => {
        const url = getDownloadUrl(tool);
        if (url) shell.openExternal(url);
    });
    handle('shell:openExternal', (_e, url) => {
        if (url && (url.startsWith('https://') || url.startsWith('http://'))) shell.openExternal(url);
    });

    handle('tools:openTerminal', (_e, projectPath) => {
        const { spawn } = require('child_process');
        if (process.platform === 'darwin') {
            spawn('open', ['-a', 'Terminal', projectPath], { detached: true, stdio: 'ignore' }).unref();
        } else if (process.platform === 'win32') {
            spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/K', `cd /d "${projectPath}"`], { detached: true, stdio: 'ignore', shell: true }).unref();
        }
    });
    handle('tools:openInFinder', (_e, projectPath) => {
        shell.showItemInFolder(projectPath);
    });
    handle('tools:openCourseFolder', (_e, projectPath) => {
        const coursePath = join(projectPath, 'course');
        shell.openPath(existsSync(coursePath) ? coursePath : projectPath);
    });

    // --- Chat ---
    handle('chat:send', (e, projectPath, message, mentions, mode) => {
        sendMessage(projectPath, message, mentions, e.sender, mode);
    });
    handle('chat:stop', (_e, projectPath) => stopGeneration(projectPath));
    handle('chat:clear', (_e, projectPath) => clearConversation(projectPath));
    handle('chat:approveToolCall', (_e, projectPath, toolUseId, approved) => resolveToolApproval(projectPath, toolUseId, approved));
    handle('chat:loadHistory', (_e, projectPath) => loadHistory(projectPath));
    handle('chat:getMentions', (_e, projectPath) => buildMentionIndex(projectPath));
    handle('chat:summarizeContext', (_e, projectPath) => summarizeContext(projectPath));
    handle('chat:getContextMemory', (_e, projectPath) => getContextMemory(projectPath));
    handle('chat:getSessionContext', (_e, projectPath) => getSessionContext(projectPath));

    // --- References ---
    handle('refs:list', (_e, projectPath) => listRefs(projectPath));
    handle('refs:read', (_e, projectPath, filename) => readRef(projectPath, filename));
    handle('refs:convert', (e, projectPath, filePath) => convertRef(projectPath, filePath, e.sender));

    // --- AI Settings ---
    handle('ai:getConfig', async () => {
        const settings = getAllSettings();
        const currentProvider = settings.aiProvider;
        const currentModel = settings.aiModel;
        const providers = await getProviders();
        return {
            providers,
            currentProvider,
            currentModel,
            hasKey: hasApiKey(currentProvider),
            // Legacy aliases for existing renderer code.
            provider: currentProvider,
            model: currentModel,
            customInstructions: settings.aiCustomInstructions
        };
    });
    handle('ai:setProvider', (_e, provider) => saveSetting('aiProvider', provider));
    handle('ai:setModel', (_e, model) => saveSetting('aiModel', model));
    handle('ai:setApiKey', async (_e, provider, apiKey) => {
        const { createProvider } = await import('./llm-provider.js');
        const p = await createProvider(provider, apiKey);
        const result = await p.validateKey();
        if (result.valid) {
            saveApiKey(provider, apiKey);
        }
        return result;
    });
    handle('ai:removeApiKey', (_e, provider) => removeApiKey(provider));
    handle('ai:setCustomInstructions', (_e, text) => saveSetting('aiCustomInstructions', text));
    handle('ai:getProviders', () => getProviders());
    handle('ai:getCloudModels', async () => {
        const token = loadToken();
        if (!token) return [];
        return await getCloudModels(token);
    });
    handle('ai:getCloudUsage', async () => {
        const token = loadToken();
        if (!token) return null;
        return await getCloudUsage(token);
    });

    // --- App ---
    handle('app:getVersion', () => app.getVersion());
    handle('app:checkForUpdates', () => checkForUpdates());
    handle('app:getUpdateStatus', () => getUpdateStatus());
    handle('app:installUpdate', () => installDownloadedUpdate());
    handle('dialog:pickFolder', async (_e, defaultPath) => {
        const result = await dialog.showOpenDialog({
            properties: ['openDirectory', 'createDirectory'],
            defaultPath: defaultPath || undefined,
            title: 'Choose Project Location'
        });
        return result.canceled ? null : result.filePaths[0];
    });
    handle('dialog:saveFile', async (_e, defaultName) => {
        const downloadsPath = app.getPath('downloads');
        const result = await dialog.showSaveDialog({
            title: 'Export Course Package',
            defaultPath: join(downloadsPath, defaultName || 'course.zip'),
            filters: [{ name: 'ZIP Archive', extensions: ['zip'] }]
        });
        return result.canceled ? null : result.filePath;
    });

    // --- Outline ---
    handle('outline:load', (_e, projectPath) => {
        const outlinePath = join(projectPath, 'course', 'COURSE_OUTLINE.md');
        if (existsSync(outlinePath)) {
            return { content: readFileSync(outlinePath, 'utf-8'), exists: true };
        }
        return { content: '', exists: false };
    });
    handle('outline:save', (_e, projectPath, content) => {
        const courseDir = join(projectPath, 'course');
        mkdirSync(courseDir, { recursive: true });
        writeFileSync(join(courseDir, 'COURSE_OUTLINE.md'), content, 'utf-8');
        return { success: true };
    });

    // --- Workflows ---
    handle('workflow:run', (e, workflowId, projectPath) => {
        runWorkflow(workflowId, projectPath, e.sender);
    });
    handle('workflow:cancel', (_e, projectPath) => cancelWorkflow(projectPath));

    // --- Files (Monaco Editor) ---
    handle('files:read', (_e, projectPath, filePath) => readProjectFile(projectPath, filePath));
    handle('files:write', (_e, projectPath, filePath, content) => writeProjectFile(projectPath, filePath, content));
    handle('files:listDir', (_e, projectPath, relativePath) => listDirectory(projectPath, relativePath));

    // --- Snapshots ---
    handle('snapshots:list', (_e, projectPath) => listSnapshots(projectPath));
    handle('snapshots:create', (_e, projectPath, label) => createSnapshot(projectPath, label));
    handle('snapshots:restore', async (_e, projectPath, snapshotId) => {
        const restored = await restoreSnapshot(projectPath, snapshotId);
        resetConversationCache(projectPath, { reloadFromDisk: true });
        return restored;
    });
    handle('snapshots:changes', (_e, projectPath) => getChanges(projectPath));
    handle('snapshots:diff', (_e, projectPath, snapshotId) => diffSnapshot(projectPath, snapshotId));
    handle('snapshots:fileDiff', (_e, projectPath, snapshotId, filepath) => diffSnapshotFile(projectPath, snapshotId, filepath));
    handle('snapshots:applyFileVersion', async (_e, projectPath, snapshotId, filepath, source) => {
        const result = await applySnapshotFileVersion(projectPath, snapshotId, filepath, source);
        const changes = await getChanges(projectPath);
        const totalChanged = (changes.added?.length || 0) + (changes.modified?.length || 0) + (changes.deleted?.length || 0);

        let snapshot = null;
        if (totalChanged > 0) {
            const actionLabel = source === 'parent' ? 'Applied previous file version' : 'Applied snapshot file version';
            snapshot = await createSnapshot(projectPath, `${actionLabel}: ${filepath}`, {
                files: changes,
                source: 'chat-file-version',
                filepath,
                versionSource: source
            });
        }

        return {
            result,
            changes,
            snapshot
        };
    });
    handle('snapshots:hasRepo', (_e, projectPath) => hasRepo(projectPath));
}
