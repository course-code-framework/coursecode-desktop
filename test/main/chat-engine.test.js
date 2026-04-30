import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTempUserData, setUserDataDir } from '../mocks/electron.js';

vi.mock('electron', () => import('../mocks/electron.js'));

const providerFactory = vi.fn();
const loadApiKey = vi.fn(() => 'test-key');
const estimateCost = vi.fn(() => 0.01);
const getCloudModels = vi.fn(async () => []);
const getProviderModels = vi.fn(() => []);
const getModelContextWindow = vi.fn(() => null);
const mcpCallTool = vi.fn(async () => ({ content: [] }));
const getMcpTools = vi.fn(async () => []);
const getMcpInstructions = vi.fn(async () => null);
const getCurrentSlideId = vi.fn(async () => null);

vi.mock('../../main/llm-provider.js', () => ({
    createProvider: providerFactory,
    loadApiKey,
    estimateCost,
    getCloudModels,
    getProviderModels,
    getModelContextWindow
}));

vi.mock('../../main/cloud-client.js', () => ({
    loadToken: vi.fn(() => null)
}));

const buildSystemPrompt = vi.fn(() => 'system prompt');
vi.mock('../../main/system-prompts.js', () => ({
    buildSystemPrompt
}));

vi.mock('../../main/settings.js', () => ({
    getSetting: vi.fn((key) => {
        if (key === 'aiProvider') return 'anthropic';
        if (key === 'aiModel') return null;
        if (key === 'cloudAiModel') return null;
        return null;
    })
}));

vi.mock('../../main/preview-manager.js', () => ({
    startPreview: vi.fn(async () => ({ port: 3000 })),
    getPreviewStatus: vi.fn(() => 'stopped')
}));

vi.mock('../../main/mcp-client.js', () => ({
    getMcpClient: vi.fn(async () => ({ callTool: mcpCallTool })),
    getMcpTools,
    getMcpInstructions,
    getCurrentSlideId
}));

vi.mock('../../main/ref-manager.js', () => ({
    listRefs: vi.fn(() => []),
    readRef: vi.fn(() => ({ content: '' }))
}));

vi.mock('../../main/snapshot-manager.js', () => ({
    createSnapshot: vi.fn(async () => ({ id: 'snap-id' })),
    getChanges: vi.fn(async () => ({ added: [], modified: [], deleted: [] }))
}));

vi.mock('../../main/errors.js', () => ({
    translateChatError: vi.fn((err) => err?.message || 'error')
}));

const { sendMessage, resolveToolApproval, loadHistory } = await import('../../main/chat-engine.js');
const settingsModule = await import('../../main/settings.js');
const previewModule = await import('../../main/preview-manager.js');
const snapshotModule = await import('../../main/snapshot-manager.js');
const getSettingMock = settingsModule.getSetting;
const getPreviewStatusMock = previewModule.getPreviewStatus;
const createSnapshotMock = snapshotModule.createSnapshot;

function defaultSettingValue(key) {
    if (key === 'aiProvider') return 'anthropic';
    if (key === 'aiModel') return 'claude-sonnet-4-20250514';
    if (key === 'cloudAiModel') return null;
    return null;
}

function createWebContentsMock() {
    return {
        isDestroyed: () => false,
        send: vi.fn()
    };
}

function listFilesRecursive(root) {
    if (!existsSync(root)) return [];
    const out = [];
    const stack = [root];
    while (stack.length) {
        const dir = stack.pop();
        for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            const st = statSync(full);
            if (st.isDirectory()) stack.push(full);
            else out.push(full);
        }
    }
    return out;
}

describe('chat-engine storage and safety', () => {
    let projectDir;
    let userDataDir;

    beforeEach(() => {
        getSettingMock.mockImplementation(defaultSettingValue);
        getPreviewStatusMock.mockReturnValue('stopped');
        getMcpTools.mockResolvedValue([]);
        getMcpInstructions.mockResolvedValue(null);
        getCurrentSlideId.mockResolvedValue(null);
        mcpCallTool.mockResolvedValue({ content: [] });
        projectDir = mkdtempSync(join(tmpdir(), 'cc-chat-engine-test-'));
        userDataDir = createTempUserData();
        setUserDataDir(userDataDir);

        // Minimal project structure used by context readers.
        const courseDir = join(projectDir, 'course');
        rmSync(courseDir, { recursive: true, force: true });
        writeFileSync(join(projectDir, 'course-config.js'), '');
    });

    afterEach(() => {
        rmSync(projectDir, { recursive: true, force: true });
        rmSync(userDataDir, { recursive: true, force: true });
        vi.clearAllMocks();
    });

    it('stores chat history under userData and not in project .chat', async () => {
        providerFactory.mockResolvedValue({
            async *chat() {
                yield { type: 'text', text: 'Hello from AI' };
                yield { type: 'done', stopReason: 'stop', usage: { inputTokens: 10, outputTokens: 20 } };
            }
        });

        const webContents = createWebContentsMock();
        await sendMessage(projectDir, 'Hi', [], webContents, 'byok');

        expect(existsSync(join(projectDir, '.chat'))).toBe(false);
        const chatFiles = listFilesRecursive(join(userDataDir, 'chat-history'));
        expect(chatFiles.some(file => file.endsWith('conversation.json'))).toBe(true);
    });

    it('emits and persists the pre-chat restore point as soon as it is created', async () => {
        createSnapshotMock.mockResolvedValueOnce({
            id: 'pre-chat-snap',
            label: 'Before AI changes',
            timestamp: '2026-04-30T12:00:00.000Z'
        });
        providerFactory.mockResolvedValue({
            async *chat() {
                yield { type: 'text', text: 'Working on it.' };
                yield { type: 'done', stopReason: 'stop', usage: { inputTokens: 10, outputTokens: 20 } };
            }
        });

        const webContents = createWebContentsMock();
        await sendMessage(projectDir, 'Make a change', [], webContents, 'byok');

        expect(webContents.send).toHaveBeenCalledWith('chat:restorePoint', expect.objectContaining({
            projectPath: projectDir,
            chatIndex: 0,
            snapshotId: 'pre-chat-snap'
        }));
        expect(loadHistory(projectDir)[0]).toEqual(expect.objectContaining({
            role: 'user',
            restoreSnapshotId: 'pre-chat-snap'
        }));
    });

    it('keeps the pre-chat restore point available when generation is cancelled', async () => {
        createSnapshotMock.mockResolvedValueOnce({
            id: 'cancel-snap',
            label: 'Before AI changes',
            timestamp: '2026-04-30T12:00:00.000Z'
        });
        const abortErr = new Error('cancelled');
        abortErr.name = 'AbortError';
        providerFactory.mockResolvedValue({
            async *chat() {
                throw abortErr;
            }
        });

        const webContents = createWebContentsMock();
        await sendMessage(projectDir, 'Start then cancel', [], webContents, 'byok');

        const history = loadHistory(projectDir);
        expect(history[0]).toEqual(expect.objectContaining({
            role: 'user',
            restoreSnapshotId: 'cancel-snap'
        }));
        expect(webContents.send).toHaveBeenCalledWith('chat:restorePoint', expect.objectContaining({
            snapshotId: 'cancel-snap'
        }));
        expect(webContents.send).not.toHaveBeenCalledWith('chat:error', expect.anything());
    });

    it('blocks path traversal for edit_file tool calls', async () => {
        const outsidePath = join(projectDir, '..', 'evil.txt');
        let callCount = 0;

        providerFactory.mockResolvedValue({
            async *chat() {
                callCount += 1;
                if (callCount === 1) {
                    yield { type: 'tool_use_start', id: 'tool-1', name: 'edit_file' };
                    yield { type: 'tool_use_delta', json: JSON.stringify({ path: '../evil.txt', old_string: 'x', new_string: 'bad' }) };
                    yield { type: 'content_block_stop', index: 0 };
                    yield { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } };
                    return;
                }

                yield { type: 'text', text: 'Could not write outside the project.' };
                yield { type: 'done', stopReason: 'stop', usage: { inputTokens: 8, outputTokens: 12 } };
            }
        });

        const webContents = createWebContentsMock();
        await sendMessage(projectDir, 'Try writing outside', [], webContents, 'byok');

        expect(existsSync(outsidePath)).toBe(false);
    });

    it('edit_file rejects when old_string matches zero times', async () => {
        const { mkdirSync } = await import('fs');
        mkdirSync(join(projectDir, 'course'), { recursive: true });
        writeFileSync(join(projectDir, 'course', 'test.js'), 'const x = 1;');
        let callCount = 0;

        providerFactory.mockResolvedValue({
            async *chat() {
                callCount += 1;
                if (callCount === 1) {
                    yield { type: 'tool_use_start', id: 'tool-1', name: 'edit_file' };
                    yield { type: 'tool_use_delta', json: JSON.stringify({ path: 'test.js', old_string: 'NONEXISTENT', new_string: 'replaced' }) };
                    yield { type: 'content_block_stop', index: 0 };
                    yield { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } };
                    return;
                }
                yield { type: 'text', text: 'Could not find the text.' };
                yield { type: 'done', stopReason: 'stop', usage: { inputTokens: 8, outputTokens: 12 } };
            }
        });

        const webContents = createWebContentsMock();
        await sendMessage(projectDir, 'Edit the file', [], webContents, 'byok');

        // File should be unchanged
        expect(readFileSync(join(projectDir, 'course', 'test.js'), 'utf-8')).toBe('const x = 1;');
    });

    it('returns structured recovery guidance for failed tool calls', async () => {
        const { mkdirSync } = await import('fs');
        mkdirSync(join(projectDir, 'course'), { recursive: true });
        writeFileSync(join(projectDir, 'course', 'test.js'), 'const x = 1;');

        providerFactory.mockResolvedValue({
            async *chat() {
                yield { type: 'tool_use_start', id: 'tool-1', name: 'edit_file' };
                yield { type: 'tool_use_delta', json: JSON.stringify({ path: 'test.js', old_string: 'missing', new_string: 'updated' }) };
                yield { type: 'content_block_stop', index: 0 };
                yield { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } };
            }
        });

        const webContents = createWebContentsMock();
        await sendMessage(projectDir, 'Edit the file', [], webContents, 'byok');

        const conversationFile = listFilesRecursive(join(userDataDir, 'chat-history'))
            .find(file => file.endsWith('conversation.json'));
        const conversation = JSON.parse(readFileSync(conversationFile, 'utf-8'));
        const toolMessage = conversation.messages.find(msg => msg.role === 'tool' && msg.tool_use_id === 'tool-1');
        const toolResult = JSON.parse(toolMessage.content);

        expect(toolResult).toEqual(expect.objectContaining({
            success: false,
            recovery: expect.objectContaining({
                suggestedTools: expect.arrayContaining(['read_file', 'search_files', 'edit_file'])
            }),
            attemptedInput: expect.objectContaining({
                path: 'test.js',
                oldStringChars: 7,
                newStringChars: 7
            })
        }));
    });

    it('edit_file rejects when old_string matches multiple times', async () => {
        const { mkdirSync } = await import('fs');
        mkdirSync(join(projectDir, 'course'), { recursive: true });
        writeFileSync(join(projectDir, 'course', 'dup.js'), 'aaa\naaa\naaa');
        let callCount = 0;

        providerFactory.mockResolvedValue({
            async *chat() {
                callCount += 1;
                if (callCount === 1) {
                    yield { type: 'tool_use_start', id: 'tool-1', name: 'edit_file' };
                    yield { type: 'tool_use_delta', json: JSON.stringify({ path: 'dup.js', old_string: 'aaa', new_string: 'bbb' }) };
                    yield { type: 'content_block_stop', index: 0 };
                    yield { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } };
                    return;
                }
                yield { type: 'text', text: 'Too many matches.' };
                yield { type: 'done', stopReason: 'stop', usage: { inputTokens: 8, outputTokens: 12 } };
            }
        });

        const webContents = createWebContentsMock();
        await sendMessage(projectDir, 'Edit the file', [], webContents, 'byok');

        const { readFileSync } = await import('fs');
        expect(readFileSync(join(projectDir, 'course', 'dup.js'), 'utf-8')).toBe('aaa\naaa\naaa');
    });

    it('create_file refuses to overwrite an existing file', async () => {
        const { mkdirSync } = await import('fs');
        mkdirSync(join(projectDir, 'course'), { recursive: true });
        writeFileSync(join(projectDir, 'course', 'existing.js'), 'original');
        let callCount = 0;

        providerFactory.mockResolvedValue({
            async *chat() {
                callCount += 1;
                if (callCount === 1) {
                    yield { type: 'tool_use_start', id: 'tool-1', name: 'create_file' };
                    yield { type: 'tool_use_delta', json: JSON.stringify({ path: 'existing.js', content: 'overwritten!' }) };
                    yield { type: 'content_block_stop', index: 0 };
                    yield { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } };
                    return;
                }
                yield { type: 'text', text: 'File already exists.' };
                yield { type: 'done', stopReason: 'stop', usage: { inputTokens: 8, outputTokens: 12 } };
            }
        });

        const webContents = createWebContentsMock();
        await sendMessage(projectDir, 'Create the file', [], webContents, 'byok');

        const { readFileSync } = await import('fs');
        expect(readFileSync(join(projectDir, 'course', 'existing.js'), 'utf-8')).toBe('original');
    });

    it('list_files lists course directory contents', async () => {
        const { mkdirSync } = await import('fs');
        mkdirSync(join(projectDir, 'course', 'slides'), { recursive: true });
        mkdirSync(join(projectDir, 'course', 'assessments'), { recursive: true });
        writeFileSync(join(projectDir, 'course', 'course-config.js'), '{}');
        writeFileSync(join(projectDir, 'course', '.DS_Store'), '');

        let toolResult = null;
        let callCount = 0;

        providerFactory.mockResolvedValue({
            async *chat(opts) {
                callCount += 1;
                if (callCount === 1) {
                    yield { type: 'tool_use_start', id: 'tool-1', name: 'list_files' };
                    yield { type: 'tool_use_delta', json: JSON.stringify({ path: '.' }) };
                    yield { type: 'content_block_stop', index: 0 };
                    yield { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } };
                    return;
                }
                // Capture the tool result from the messages
                const lastMsg = opts.messages[opts.messages.length - 1];
                if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content)) {
                    const result = lastMsg.content.find(b => b.type === 'tool_result');
                    if (result) toolResult = result.content;
                }
                yield { type: 'text', text: 'Listed files.' };
                yield { type: 'done', stopReason: 'stop', usage: { inputTokens: 8, outputTokens: 12 } };
            }
        });

        const webContents = createWebContentsMock();
        await sendMessage(projectDir, 'List files', [], webContents, 'byok');

        expect(toolResult).toBeTruthy();
        const parsed = JSON.parse(toolResult);
        const names = parsed.files.map(f => f.name);
        expect(names).not.toContain('.DS_Store');
        expect(names).toContain('slides');
        expect(names).toContain('assessments');
        expect(names).toContain('course-config.js');
    });

    it('requires approval before real narration generation even in auto mode', async () => {
        getPreviewStatusMock.mockReturnValue('running');
        getMcpTools.mockResolvedValue([{
            name: 'coursecode_narration',
            description: 'Generate narration',
            inputSchema: { type: 'object', properties: { dryRun: { type: 'boolean' } } }
        }]);

        let callCount = 0;
        providerFactory.mockResolvedValue({
            async *chat() {
                callCount += 1;
                if (callCount === 1) {
                    yield { type: 'tool_use_start', id: 'tool-1', name: 'coursecode_narration' };
                    yield { type: 'tool_use_delta', json: JSON.stringify({ dryRun: false }) };
                    yield { type: 'content_block_stop', index: 0 };
                    yield { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } };
                    return;
                }
                yield { type: 'text', text: 'Narration generation was not run.' };
                yield { type: 'done', stopReason: 'stop', usage: { inputTokens: 8, outputTokens: 12 } };
            }
        });

        const webContents = createWebContentsMock();
        webContents.send.mockImplementation((channel, payload) => {
            if (channel === 'chat:toolApproval') {
                resolveToolApproval(projectDir, payload.toolUseId, false);
            }
        });

        await sendMessage(projectDir, 'Regenerate narration', [], webContents, 'byok');

        expect(webContents.send).toHaveBeenCalledWith('chat:toolUse', expect.objectContaining({
            tool: 'coursecode_narration',
            status: 'pending_approval'
        }));
        expect(mcpCallTool).not.toHaveBeenCalledWith('coursecode_narration', expect.anything());
    });

});
