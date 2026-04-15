import { contextBridge, ipcRenderer, webUtils, clipboard } from 'electron';

contextBridge.exposeInMainWorld('api', {
    getFilePath: (file) => webUtils.getPathForFile(file),

    projects: {
        scan: () => ipcRenderer.invoke('projects:scan'),
        create: (options) => ipcRenderer.invoke('projects:create', options),
        open: (projectPath) => ipcRenderer.invoke('projects:open', projectPath),
        reveal: (projectPath) => ipcRenderer.invoke('projects:reveal', projectPath),
        delete: (projectPath, options) => ipcRenderer.invoke('projects:delete', projectPath, options),
        clearCloudBinding: (projectPath) => ipcRenderer.invoke('projects:clearCloudBinding', projectPath),
        upgrade: (projectPath) => ipcRenderer.invoke('projects:upgrade', projectPath),
        onUpgradeProgress: (callback) => {
            const handler = (_event, data) => callback(data);
            ipcRenderer.on('project:upgradeProgress', handler);
            return () => ipcRenderer.removeListener('project:upgradeProgress', handler);
        }
    },

    preview: {
        start: (projectPath, opts) => ipcRenderer.invoke('preview:start', projectPath, opts),
        stop: (projectPath) => ipcRenderer.invoke('preview:stop', projectPath),
        status: (projectPath) => ipcRenderer.invoke('preview:status', projectPath),
        port: (projectPath) => ipcRenderer.invoke('preview:port', projectPath),
        statusAll: () => ipcRenderer.invoke('preview:statusAll'),
        onLog: (callback) => {
            const handler = (_event, data) => callback(data);
            ipcRenderer.on('preview:log', handler);
            return () => ipcRenderer.removeListener('preview:log', handler);
        },
        onOpenInBrowser: (callback) => {
            const handler = () => callback();
            ipcRenderer.on('open-preview-in-browser', handler);
            return () => ipcRenderer.removeListener('open-preview-in-browser', handler);
        },
        onContextMenu: (callback) => {
            const handler = (_event, data) => callback(data);
            ipcRenderer.on('preview:contextMenu', handler);
            return () => ipcRenderer.removeListener('preview:contextMenu', handler);
        },
        selectAll: (frameURL) => ipcRenderer.invoke('preview:selectAll', frameURL),
        toggleEditMode: (port) => ipcRenderer.invoke('preview:toggleEditMode', port)
    },

    build: {
        export: (projectPath, format, savePath) => ipcRenderer.invoke('build:export', projectPath, format, savePath),
        onProgress: (callback) => {
            const handler = (_event, data) => callback(data);
            ipcRenderer.on('build:progress', handler);
            return () => ipcRenderer.removeListener('build:progress', handler);
        }
    },

    cloud: {
        login: () => ipcRenderer.invoke('cloud:login'),
        logout: () => ipcRenderer.invoke('cloud:logout'),
        getUser: () => ipcRenderer.invoke('cloud:getUser'),
        deploy: (projectPath, options) => ipcRenderer.invoke('cloud:deploy', projectPath, options),
        getDeployStatus: (projectId, options) => ipcRenderer.invoke('cloud:getDeployStatus', projectId, options),
        updatePreviewLink: (projectPath, options) => ipcRenderer.invoke('cloud:updatePreviewLink', projectPath, options),
        onLoginProgress: (callback) => {
            const handler = (_event, data) => callback(data);
            ipcRenderer.on('cloud:loginProgress', handler);
            return () => ipcRenderer.removeListener('cloud:loginProgress', handler);
        },
        onDeployProgress: (callback) => {
            const handler = (_event, data) => callback(data);
            ipcRenderer.on('cloud:deployProgress', handler);
            return () => ipcRenderer.removeListener('cloud:deployProgress', handler);
        }
    },

    settings: {
        get: () => ipcRenderer.invoke('settings:get'),
        set: (key, value) => ipcRenderer.invoke('settings:set', key, value)
    },

    setup: {
        getStatus: () => ipcRenderer.invoke('setup:getStatus'),
        installCLI: () => ipcRenderer.invoke('setup:installCLI'),
        onInstallProgress: (callback) => {
            const handler = (_event, data) => callback(data);
            ipcRenderer.on('setup:installProgress', handler);
            return () => ipcRenderer.removeListener('setup:installProgress', handler);
        },
        openDownloadPage: (tool) => ipcRenderer.invoke('setup:openDownloadPage', tool)
    },

    shell: {
        openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url)
    },

    clipboard: {
        writeText: (text) => clipboard.writeText(text)
    },

    tools: {
        openTerminal: (projectPath) => ipcRenderer.invoke('tools:openTerminal', projectPath),
        openInFinder: (projectPath) => ipcRenderer.invoke('tools:openInFinder', projectPath),
        openCourseFolder: (projectPath) => ipcRenderer.invoke('tools:openCourseFolder', projectPath)
    },

    version: {
        getLatest: () => ipcRenderer.invoke('version:getLatest')
    },

    app: {
        getVersion: () => ipcRenderer.invoke('app:getVersion'),
        checkForUpdates: () => ipcRenderer.invoke('app:checkForUpdates'),
        getUpdateStatus: () => ipcRenderer.invoke('app:getUpdateStatus'),
        installUpdate: () => ipcRenderer.invoke('app:installUpdate'),
        onUpdateAvailable: (callback) => {
            const handler = (_event, data) => callback(data);
            ipcRenderer.on('app:updateAvailable', handler);
            return () => ipcRenderer.removeListener('app:updateAvailable', handler);
        },
        onUpdateStatus: (callback) => {
            const handler = (_event, data) => callback(data);
            ipcRenderer.on('app:updateStatus', handler);
            return () => ipcRenderer.removeListener('app:updateStatus', handler);
        },
        onNavigate: (callback) => {
            const handler = (_event, target) => callback(target);
            ipcRenderer.on('navigate', handler);
            return () => ipcRenderer.removeListener('navigate', handler);
        }
    },

    // --- Files (Monaco Editor) ---
    files: {
        read: (projectPath, filePath) => ipcRenderer.invoke('files:read', projectPath, filePath),
        write: (projectPath, filePath, content) => ipcRenderer.invoke('files:write', projectPath, filePath, content),
        listDir: (projectPath, relativePath) => ipcRenderer.invoke('files:listDir', projectPath, relativePath)
    },

    dialog: {
        pickFolder: (defaultPath) => ipcRenderer.invoke('dialog:pickFolder', defaultPath),
        saveFile: (defaultName) => ipcRenderer.invoke('dialog:saveFile', defaultName),
        pickFiles: (defaultPath) => ipcRenderer.invoke('dialog:pickFiles', defaultPath)
    },

    // --- Outline ---
    outline: {
        load: (projectPath) => ipcRenderer.invoke('outline:load', projectPath),
        save: (projectPath, content) => ipcRenderer.invoke('outline:save', projectPath, content)
    },

    // --- Workflows ---
    workflow: {
        run: (workflowId, projectPath) => ipcRenderer.invoke('workflow:run', workflowId, projectPath),
        cancel: (projectPath) => ipcRenderer.invoke('workflow:cancel', projectPath),
        onProgress: (callback) => {
            const handler = (_event, data) => callback(data);
            ipcRenderer.on('workflow:progress', handler);
            return () => ipcRenderer.removeListener('workflow:progress', handler);
        }
    },

    // --- Snapshots ---
    snapshots: {
        list: (projectPath) => ipcRenderer.invoke('snapshots:list', projectPath),
        create: (projectPath, label) => ipcRenderer.invoke('snapshots:create', projectPath, label),
        restore: (projectPath, snapshotId) => ipcRenderer.invoke('snapshots:restore', projectPath, snapshotId),
        changes: (projectPath) => ipcRenderer.invoke('snapshots:changes', projectPath),
        diff: (projectPath, snapshotId) => ipcRenderer.invoke('snapshots:diff', projectPath, snapshotId),
        fileDiff: (projectPath, snapshotId, filepath) => ipcRenderer.invoke('snapshots:fileDiff', projectPath, snapshotId, filepath),
        applyFileVersion: (projectPath, snapshotId, filepath, source) => ipcRenderer.invoke('snapshots:applyFileVersion', projectPath, snapshotId, filepath, source),
        hasRepo: (projectPath) => ipcRenderer.invoke('snapshots:hasRepo', projectPath)
    },

    // --- AI Chat ---
    chat: {
        send: (projectPath, message, mentions, mode) => ipcRenderer.invoke('chat:send', projectPath, message, mentions, mode),
        stop: (projectPath) => ipcRenderer.invoke('chat:stop', projectPath),
        clear: (projectPath) => ipcRenderer.invoke('chat:clear', projectPath),
        listConversations: (projectPath) => ipcRenderer.invoke('chat:listConversations', projectPath),
        loadConversation: (projectPath, conversationId) => ipcRenderer.invoke('chat:loadConversation', projectPath, conversationId),
        deleteConversation: (projectPath, conversationId) => ipcRenderer.invoke('chat:deleteConversation', projectPath, conversationId),
        deleteAllConversations: (projectPath) => ipcRenderer.invoke('chat:deleteAllConversations', projectPath),
        approveToolCall: (projectPath, toolUseId, approved) => ipcRenderer.invoke('chat:approveToolCall', projectPath, toolUseId, approved),
        loadHistory: (projectPath) => ipcRenderer.invoke('chat:loadHistory', projectPath),
        getMentions: (projectPath) => ipcRenderer.invoke('chat:getMentions', projectPath),
        getSessionContext: (projectPath) => ipcRenderer.invoke('chat:getSessionContext', projectPath),
        onStream: (callback) => {
            const handler = (_event, data) => callback(data);
            ipcRenderer.on('chat:stream', handler);
            return () => ipcRenderer.removeListener('chat:stream', handler);
        },
        onToolUse: (callback) => {
            const handler = (_event, data) => callback(data);
            ipcRenderer.on('chat:toolUse', handler);
            return () => ipcRenderer.removeListener('chat:toolUse', handler);
        },
        onToolArgsDelta: (callback) => {
            const handler = (_event, data) => callback(data);
            ipcRenderer.on('chat:toolArgsDelta', handler);
            return () => ipcRenderer.removeListener('chat:toolArgsDelta', handler);
        },
        onScreenshot: (callback) => {
            const handler = (_event, data) => callback(data);
            ipcRenderer.on('chat:screenshot', handler);
            return () => ipcRenderer.removeListener('chat:screenshot', handler);
        },
        onError: (callback) => {
            const handler = (_event, data) => callback(data);
            ipcRenderer.on('chat:error', handler);
            return () => ipcRenderer.removeListener('chat:error', handler);
        },
        onDone: (callback) => {
            const handler = (_event, data) => callback(data);
            ipcRenderer.on('chat:done', handler);
            return () => ipcRenderer.removeListener('chat:done', handler);
        },
        onStepUsage: (callback) => {
            const handler = (_event, data) => callback(data);
            ipcRenderer.on('chat:stepUsage', handler);
            return () => ipcRenderer.removeListener('chat:stepUsage', handler);
        },
        onChangeSummary: (callback) => {
            const handler = (_event, data) => callback(data);
            ipcRenderer.on('chat:changeSummary', handler);
            return () => ipcRenderer.removeListener('chat:changeSummary', handler);
        },
        onToolApproval: (callback) => {
            const handler = (_event, data) => callback(data);
            ipcRenderer.on('chat:toolApproval', handler);
            return () => ipcRenderer.removeListener('chat:toolApproval', handler);
        },
        onNewChat: (callback) => {
            const handler = () => callback();
            ipcRenderer.on('chat:newChat', handler);
            return () => ipcRenderer.removeListener('chat:newChat', handler);
        }
    },

    // --- Reference Documents ---
    refs: {
        list: (projectPath) => ipcRenderer.invoke('refs:list', projectPath),
        read: (projectPath, filename) => ipcRenderer.invoke('refs:read', projectPath, filename),
        convert: (projectPath, filePath) => ipcRenderer.invoke('refs:convert', projectPath, filePath),
        onConvertProgress: (callback) => {
            const handler = (_event, data) => callback(data);
            ipcRenderer.on('refs:convertProgress', handler);
            return () => ipcRenderer.removeListener('refs:convertProgress', handler);
        }
    },

    // --- AI Settings ---
    ai: {
        getConfig: () => ipcRenderer.invoke('ai:getConfig'),
        setProvider: (provider) => ipcRenderer.invoke('ai:setProvider', provider),
        setModel: (model) => ipcRenderer.invoke('ai:setModel', model),
        setApiKey: (provider, apiKey) => ipcRenderer.invoke('ai:setApiKey', provider, apiKey),
        removeApiKey: (provider) => ipcRenderer.invoke('ai:removeApiKey', provider),
        setCustomInstructions: (text) => ipcRenderer.invoke('ai:setCustomInstructions', text),
        getProviders: () => ipcRenderer.invoke('ai:getProviders'),
        getCloudModels: () => ipcRenderer.invoke('ai:getCloudModels'),
        getCloudUsage: () => ipcRenderer.invoke('ai:getCloudUsage')
    }
});
