import { writable, derived } from 'svelte/store';
import { updateSetting } from './settings.js';

/** Chat messages array */
export const messages = writable([]);

/** Whether the AI is currently streaming a response */
export const streaming = writable(false);

/** Current partial text from the AI (assembled during streaming) */
export const streamingText = writable('');

/** Active tool use indicators */
export const activeTools = writable([]);

/** Execution plan state for current message */
export const chatPlan = writable({ status: 'idle', steps: [], note: '' });

/** Saved course memory summary */
export const contextMemory = writable(null);

/** Session token usage */
export const sessionUsage = writable({ inputTokens: 0, outputTokens: 0, estimatedCost: 0 });

/** Credits used in this session (cloud mode) */
export const sessionCredits = writable(0);

/** Current AI mode for this conversation: 'byok' or 'cloud' */
export const aiMode = writable('byok');

/** Cloud credit balance */
export const credits = writable(null);

/** Mention index for the current project */
export const mentionIndex = writable({ slides: [], refs: [], interactions: [] });

// --- IPC event subscriptions ---
let unsubStream = null;
let unsubToolUse = null;
let unsubScreenshot = null;
let unsubError = null;
let unsubDone = null;
let unsubChangeSummary = null;
let unsubPlan = null;
let unsubMemoryUpdated = null;

let currentAiMode = 'byok';
let activeProjectPath = null;
let pendingScreenshots = [];
aiMode.subscribe((mode) => {
    currentAiMode = mode;
});

function toNumberOrNull(value) {
    if (value == null) return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function normalizeCloudUsage(payload) {
    if (!payload || typeof payload !== 'object') return null;
    return {
        ...payload,
        total_credits: toNumberOrNull(payload.total_credits)
    };
}

export function subscribeToChatEvents() {
    unsubStream = window.api.chat.onStream(({ projectPath, text, delta }) => {
        if (activeProjectPath && projectPath && projectPath !== activeProjectPath) return;
        if (typeof delta === 'string' && delta.length > 0) {
            streamingText.update(current => `${current}${delta}`);
            return;
        }
        if (typeof text === 'string') {
            streamingText.set(text);
        }
    });

    unsubToolUse = window.api.chat.onToolUse((payload) => {
        const {
            projectPath,
            tool,
            toolUseId,
            label,
            status,
            startedAt,
            finishedAt,
            elapsedMs,
            reason,
            filePath,
            detail
        } = payload;

        if (activeProjectPath && projectPath && projectPath !== activeProjectPath) return;

        if (status === 'running') {
            activeTools.update(t => [
                ...t,
                {
                    tool,
                    toolUseId: toolUseId || `${tool}-${Date.now()}`,
                    label,
                    status,
                    startedAt: startedAt || Date.now(),
                    reason,
                    filePath,
                    detail
                }
            ]);
            return;
        }

        activeTools.update(t => t.map(tt =>
            (tt.toolUseId && tt.toolUseId === toolUseId) || (!toolUseId && tt.tool === tool && tt.status === 'running')
                ? {
                    ...tt,
                    status,
                    finishedAt: finishedAt || Date.now(),
                    elapsedMs: elapsedMs ?? (tt.startedAt ? Date.now() - tt.startedAt : null),
                    reason: reason || tt.reason,
                    filePath: filePath || tt.filePath,
                    detail: detail || tt.detail
                }
                : tt
        ));
    });

    unsubScreenshot = window.api.chat.onScreenshot(({ projectPath, imageData }) => {
        if (activeProjectPath && projectPath && projectPath !== activeProjectPath) return;
        if (!imageData) return;
        pendingScreenshots = [...pendingScreenshots, imageData];
    });

    unsubError = window.api.chat.onError(({ projectPath, message }) => {
        if (activeProjectPath && projectPath && projectPath !== activeProjectPath) return;
        streaming.set(false);
        streamingText.set('');
        activeTools.set([]);
        pendingScreenshots = [];
        messages.update(msgs => [
            ...msgs,
            { role: 'assistant', content: message, isError: true }
        ]);
    });

    unsubDone = window.api.chat.onDone(({ projectPath, usage }) => {
        if (activeProjectPath && projectPath && projectPath !== activeProjectPath) return;
        // Finalize the streaming message
        let finalText = '';
        streamingText.subscribe(v => finalText = v)();

        let tools = [];
        activeTools.subscribe(v => tools = v)();

        const normalizedText = (finalText || '').trim();
        if (normalizedText || tools.length > 0 || pendingScreenshots.length > 0) {
            messages.update(msgs => [
                ...msgs,
                {
                    role: 'assistant',
                    content: normalizedText || 'Completed.',
                    toolCalls: tools.filter(t => t.status === 'done' || t.status === 'error'),
                    screenshots: [...pendingScreenshots],
                    usage
                }
            ]);
        }

        streaming.set(false);
        streamingText.set('');
        activeTools.set([]);
        pendingScreenshots = [];
        chatPlan.set({ status: 'idle', steps: [], note: '' });

        // Update session usage
        if (usage) {
            sessionUsage.update(s => ({
                inputTokens: s.inputTokens + (usage.inputTokens || 0),
                outputTokens: s.outputTokens + (usage.outputTokens || 0),
                estimatedCost: (s.estimatedCost || 0) + (usage.estimatedCost || 0)
            }));
            if (usage.creditsCharged != null) {
                sessionCredits.update(c => c + usage.creditsCharged);
                credits.update((current) => {
                    if (!current || current.total_credits == null) return current;
                    return {
                        ...current,
                        total_credits: Math.max(0, current.total_credits - usage.creditsCharged)
                    };
                });
            }
            if (currentAiMode === 'cloud') {
                loadCredits();
            }
        }
    });

    unsubChangeSummary = window.api.chat.onChangeSummary?.(({ projectPath, label, timestamp, added, modified, deleted, snapshotId }) => {
        if (activeProjectPath && projectPath && projectPath !== activeProjectPath) return;
        messages.update(msgs => [
            ...msgs,
            {
                role: 'system',
                type: 'changeSummary',
                label,
                timestamp,
                added: added || [],
                modified: modified || [],
                deleted: deleted || [],
                snapshotId
            }
        ]);
    });

    unsubPlan = window.api.chat.onPlan?.(({ projectPath, status, steps, note }) => {
        if (activeProjectPath && projectPath && projectPath !== activeProjectPath) return;
        chatPlan.update(current => ({
            status: status || current.status,
            steps: steps || current.steps,
            note: note || current.note
        }));
    });

    unsubMemoryUpdated = window.api.chat.onMemoryUpdated?.(({ projectPath, memory }) => {
        if (activeProjectPath && projectPath && projectPath !== activeProjectPath) return;
        contextMemory.set(memory || null);
    });
}

export function unsubscribeFromChatEvents() {
    unsubStream?.();
    unsubToolUse?.();
    unsubScreenshot?.();
    unsubError?.();
    unsubDone?.();
    unsubChangeSummary?.();
    unsubPlan?.();
    unsubMemoryUpdated?.();
}

// --- Actions ---

export async function sendMessage(projectPath, text, mentions = []) {
    activeProjectPath = projectPath;
    pendingScreenshots = [];
    messages.update(msgs => [...msgs, { role: 'user', content: text, mentions }]);
    streaming.set(true);
    streamingText.set('');
    activeTools.set([]);
    chatPlan.set({ status: 'started', steps: [], note: '' });
    let mode;
    aiMode.subscribe(v => mode = v)();
    try {
        await window.api.settings.set('defaultAiMode', mode);
        await window.api.settings.set('aiModeInitialized', true);
        await window.api.chat.send(projectPath, text, mentions, mode);
    } catch (err) {
        streaming.set(false);
        streamingText.set('');
        activeTools.set([]);
        pendingScreenshots = [];
        chatPlan.set({ status: 'error', steps: [], note: '' });
        messages.update(msgs => [
            ...msgs,
            { role: 'assistant', content: err?.message || 'Failed to send message.', isError: true }
        ]);
    }
}

export async function stopGeneration(projectPath) {
    await window.api.chat.stop(projectPath);
    streaming.set(false);
    streamingText.set('');
    activeTools.set([]);
    pendingScreenshots = [];
    chatPlan.set({ status: 'cancelled', steps: [], note: 'Generation cancelled' });
}

export async function clearChat(projectPath) {
    await window.api.chat.clear(projectPath);
    activeProjectPath = projectPath;
    messages.set([]);
    streamingText.set('');
    activeTools.set([]);
    pendingScreenshots = [];
    chatPlan.set({ status: 'idle', steps: [], note: '' });
    contextMemory.set(null);
    sessionUsage.set({ inputTokens: 0, outputTokens: 0, estimatedCost: 0 });
    sessionCredits.set(0);
}

/** Load cloud credit balance. */
export async function loadCredits() {
    try {
        const usage = await window.api.ai.getCloudUsage();
        credits.set(normalizeCloudUsage(usage));
    } catch {
        credits.set(null);
    }
}

export async function loadChatHistory(projectPath) {
    activeProjectPath = projectPath;
    pendingScreenshots = [];
    const history = await window.api.chat.loadHistory(projectPath);
    messages.set(history || []);

    try {
        const session = await window.api.chat.getSessionContext?.(projectPath);
        if (session?.mode === 'cloud' || session?.mode === 'byok') {
            aiMode.set(session.mode);
            await updateSetting('defaultAiMode', session.mode);
            await updateSetting('aiModeInitialized', true);

            if (session.mode === 'byok') {
                if (session.providerId) {
                    await updateSetting('aiProvider', session.providerId);
                }
                if (session.modelId) {
                    await updateSetting('aiModel', session.modelId);
                }
            } else if (session.mode === 'cloud' && session.modelId) {
                await updateSetting('cloudAiModel', session.modelId);
            }

            if (session.mode === 'cloud') {
                await loadCredits();
            }
        }
    } catch {
        // Backward compatibility: older app versions may not expose session context.
    }

    try {
        const memory = await window.api.chat.getContextMemory(projectPath);
        contextMemory.set(memory || null);
    } catch {
        contextMemory.set(null);
    }
}

export async function refreshMentionIndex(projectPath) {
    const index = await window.api.chat.getMentions(projectPath);
    mentionIndex.set(index);
}

export async function summarizeToContext(projectPath) {
    const summary = await window.api.chat.summarizeContext(projectPath);
    contextMemory.set(summary || null);
    return summary;
}

/** Format token count for display */
export function formatTokens(count) {
    if (count < 1000) return `${count}`;
    return `${(count / 1000).toFixed(1)}k`;
}

/** Format cost for display */
export function formatCost(cost) {
    if (!cost || cost < 0.01) return '<$0.01';
    return `$${cost.toFixed(2)}`;
}
