import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
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
    getMcpClient: vi.fn(async () => ({ callTool: vi.fn(async () => ({ content: [] })) }))
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

const { sendMessage } = await import('../../main/chat-engine.js');
const settingsModule = await import('../../main/settings.js');
const getSettingMock = settingsModule.getSetting;

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
        const { readFileSync } = await import('fs');
        expect(readFileSync(join(projectDir, 'course', 'test.js'), 'utf-8')).toBe('const x = 1;');
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

});
