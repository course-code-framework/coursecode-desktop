import { writable, derived } from 'svelte/store';

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

export function subscribeToChatEvents() {
    unsubStream = window.api.chat.onStream(({ text }) => {
        streamingText.set(text);
    });

    unsubToolUse = window.api.chat.onToolUse((payload) => {
        const {
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

    unsubScreenshot = window.api.chat.onScreenshot(({ imageData }) => {
        // Append screenshot to current streaming message
        messages.update(msgs => {
            const lastMsg = msgs[msgs.length - 1];
            if (lastMsg?.role === 'assistant') {
                lastMsg.screenshots = [...(lastMsg.screenshots || []), imageData];
            }
            return [...msgs];
        });
    });

    unsubError = window.api.chat.onError(({ message }) => {
        streaming.set(false);
        streamingText.set('');
        activeTools.set([]);
        messages.update(msgs => [
            ...msgs,
            { role: 'assistant', content: message, isError: true }
        ]);
    });

    unsubDone = window.api.chat.onDone(({ usage }) => {
        // Finalize the streaming message
        let finalText = '';
        streamingText.subscribe(v => finalText = v)();

        let tools = [];
        activeTools.subscribe(v => tools = v)();

        if (finalText) {
            messages.update(msgs => [
                ...msgs,
                {
                    role: 'assistant',
                    content: finalText,
                    toolCalls: tools.filter(t => t.status === 'done' || t.status === 'error'),
                    usage
                }
            ]);
        }

        streaming.set(false);
        streamingText.set('');
        activeTools.set([]);
        chatPlan.set({ status: 'idle', steps: [], note: '' });

        // Update session usage
        if (usage) {
            sessionUsage.update(s => ({
                inputTokens: s.inputTokens + (usage.inputTokens || 0),
                outputTokens: s.outputTokens + (usage.outputTokens || 0),
                estimatedCost: (s.estimatedCost || 0) + (usage.estimatedCost || 0)
            }));
            if (usage.creditsCharged) {
                sessionCredits.update(c => c + usage.creditsCharged);
                loadCredits();
            }
        }
    });

    unsubChangeSummary = window.api.chat.onChangeSummary?.(({ added, modified, deleted, snapshotId }) => {
        messages.update(msgs => [
            ...msgs,
            {
                role: 'system',
                type: 'changeSummary',
                added: added || [],
                modified: modified || [],
                deleted: deleted || [],
                snapshotId
            }
        ]);
    });

    unsubPlan = window.api.chat.onPlan?.(({ status, steps, note }) => {
        chatPlan.update(current => ({
            status: status || current.status,
            steps: steps || current.steps,
            note: note || current.note
        }));
    });

    unsubMemoryUpdated = window.api.chat.onMemoryUpdated?.(({ memory }) => {
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
    messages.update(msgs => [...msgs, { role: 'user', content: text, mentions }]);
    streaming.set(true);
    streamingText.set('');
    activeTools.set([]);
    chatPlan.set({ status: 'started', steps: [], note: '' });
    let mode;
    aiMode.subscribe(v => mode = v)();
    await window.api.settings.set('defaultAiMode', mode);
    await window.api.settings.set('aiModeInitialized', true);
    await window.api.chat.send(projectPath, text, mentions, mode);
}

export async function stopGeneration(projectPath) {
    await window.api.chat.stop(projectPath);
    streaming.set(false);
    streamingText.set('');
    activeTools.set([]);
    chatPlan.set({ status: 'cancelled', steps: [], note: 'Generation cancelled' });
}

export async function clearChat(projectPath) {
    await window.api.chat.clear(projectPath);
    messages.set([]);
    streamingText.set('');
    activeTools.set([]);
    chatPlan.set({ status: 'idle', steps: [], note: '' });
    contextMemory.set(null);
    sessionUsage.set({ inputTokens: 0, outputTokens: 0, estimatedCost: 0 });
    sessionCredits.set(0);
}

/** Load cloud credit balance. */
export async function loadCredits() {
    try {
        const usage = await window.api.ai.getCloudUsage();
        credits.set(usage);
    } catch {
        credits.set(null);
    }
}

export async function loadChatHistory(projectPath) {
    const history = await window.api.chat.loadHistory(projectPath);
    messages.set(history || []);
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
