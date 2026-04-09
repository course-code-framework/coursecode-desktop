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

vi.mock('../../main/llm-provider.js', () => ({
    createProvider: providerFactory,
    loadApiKey,
    estimateCost,
    getCloudModels,
    getProviderModels
}));

vi.mock('../../main/cloud-client.js', () => ({
    loadToken: vi.fn(() => null)
}));

vi.mock('../../main/system-prompts.js', () => ({
    buildSystemPrompt: vi.fn(() => 'system prompt'),
    getToolDefinitions: vi.fn(() => [])
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
});
