import { writable, derived } from 'svelte/store';
import { updateSetting } from './settings.js';

// Cost warning thresholds (mirrors main/ai-config.js)
const COST_WARNING_THRESHOLDS = [2, 5, 10, 25];
const CREDIT_LOW_THRESHOLD = 50;

/** Chat messages array */
export const messages = writable([]);

/** Whether the AI is currently streaming a response */
export const streaming = writable(false);

/** Current partial text from the AI (assembled during streaming) */
export const streamingText = writable('');

/** Active tool use indicators */
export const activeTools = writable([]);

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

/** Pending tool approvals (tools waiting for user to approve/reject) */
export const pendingApprovals = writable([]);

/** Cost warning state — tracks which thresholds have been shown */
export const costWarningsShown = writable(new Set());

/** List of past conversation summaries for the history panel */
export const conversationList = writable([]);

/** ID of the currently active conversation (null for fresh/unsaved) */
export const activeConversationId = writable(null);

// --- IPC event subscriptions ---
let unsubStream = null;
let unsubToolUse = null;
let unsubScreenshot = null;
let unsubError = null;
let unsubDone = null;
let unsubChangeSummary = null;
let unsubToolApproval = null;
let unsubToolArgsDelta = null;

let currentAiMode = 'byok';
let activeProjectPath = null;
let pendingScreenshots = [];
let pendingChangeSummary = null;
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

    unsubToolArgsDelta = window.api.chat.onToolArgsDelta?.(({ projectPath, toolUseId, delta, accumulated }) => {
        if (activeProjectPath && projectPath && projectPath !== activeProjectPath) return;
        activeTools.update(t => t.map(tt =>
            tt.toolUseId === toolUseId
                ? { ...tt, streamingArgs: accumulated }
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
        pendingChangeSummary = null;
        messages.update(msgs => [
            ...msgs,
            { role: 'assistant', content: message, isError: true }
        ]);
    });

    unsubDone = window.api.chat.onDone(({ projectPath, message, usage, execution }) => {
        if (activeProjectPath && projectPath && projectPath !== activeProjectPath) return;
        // Finalize the streaming message
        let streamText = '';
        streamingText.subscribe(v => streamText = v)();
        const finalText = (typeof message === 'string' && message.trim()) ? message : streamText;

        let tools = [];
        activeTools.subscribe(v => tools = v)();

        const normalizedText = (finalText || '').trim();
        if (normalizedText || tools.length > 0 || pendingScreenshots.length > 0) {
            const assistantMsg = {
                role: 'assistant',
                content: normalizedText || 'Completed.',
                toolCalls: tools.filter(t => t.status === 'done' || t.status === 'error'),
                screenshots: [...pendingScreenshots],
                usage
            };
            if (pendingChangeSummary) {
                assistantMsg.changeSummary = pendingChangeSummary;
            }
            messages.update(msgs => [...msgs, assistantMsg]);
        }

        streaming.set(false);
        streamingText.set('');
        activeTools.set([]);
        pendingChangeSummary = null;
        pendingScreenshots = [];

        // Update session usage
        if (usage) {
            sessionUsage.update(s => ({
                inputTokens: s.inputTokens + (usage.inputTokens || 0),
                outputTokens: s.outputTokens + (usage.outputTokens || 0),
                estimatedCost: (s.estimatedCost || 0) + (usage.estimatedCost || 0)
            }));

            // Check cost warning thresholds (BYOK mode)
            if (currentAiMode === 'byok' && usage.estimatedCost > 0) {
                let totalCost = 0;
                sessionUsage.subscribe(s => totalCost = s.estimatedCost)();
                costWarningsShown.update(shown => {
                    const newShown = new Set(shown);
                    // Find the highest threshold crossed that hasn't been shown yet
                    let highestNewThreshold = null;
                    for (const threshold of COST_WARNING_THRESHOLDS) {
                        if (totalCost >= threshold && !shown.has(threshold)) {
                            newShown.add(threshold);
                            highestNewThreshold = threshold;
                        }
                    }
                    if (highestNewThreshold !== null) {
                        messages.update(msgs => [...msgs, {
                            role: 'system',
                            type: 'costWarning',
                            content: `Session cost has reached $${highestNewThreshold}. Total so far: $${totalCost.toFixed(2)}.`
                        }]);
                    }
                    return newShown;
                });
            }

            if (usage.creditsCharged != null) {
                sessionCredits.update(c => c + usage.creditsCharged);
                credits.update((current) => {
                    if (!current || current.total_credits == null) return current;
                    return {
                        ...current,
                        total_credits: Math.max(0, current.total_credits - usage.creditsCharged)
                    };
                });

                // Check low credit warning (cloud mode)
                let currentCredits = null;
                credits.subscribe(c => currentCredits = c)();
                if (currentCredits?.total_credits != null && currentCredits.total_credits < CREDIT_LOW_THRESHOLD) {
                    costWarningsShown.update(shown => {
                        if (shown.has('low_credits')) return shown;
                        const newShown = new Set(shown);
                        newShown.add('low_credits');
                        messages.update(msgs => [...msgs, {
                            role: 'system',
                            type: 'costWarning',
                            content: `Your cloud credits are running low (${currentCredits.total_credits.toFixed(0)} remaining).`
                        }]);
                        return newShown;
                    });
                }
            }
            if (currentAiMode === 'cloud') {
                loadCredits();
            }
        }
    });

    unsubChangeSummary = window.api.chat.onChangeSummary?.(({ projectPath, label, timestamp, added, modified, deleted, snapshotId }) => {
        if (activeProjectPath && projectPath && projectPath !== activeProjectPath) return;
        pendingChangeSummary = { label, timestamp, added: added || [], modified: modified || [], deleted: deleted || [], snapshotId };
    });

    unsubToolApproval = window.api.chat.onToolApproval?.(({ projectPath, toolUseId, tool, label, input, filePath }) => {
        if (activeProjectPath && projectPath && projectPath !== activeProjectPath) return;
        pendingApprovals.update(list => [...list, { toolUseId, tool, label, input, filePath }]);
    });
}

export function unsubscribeFromChatEvents() {
    unsubStream?.();
    unsubToolUse?.();
    unsubToolArgsDelta?.();
    unsubScreenshot?.();
    unsubError?.();
    unsubDone?.();
    unsubChangeSummary?.();
    unsubToolApproval?.();
}

// --- Actions ---

export async function approveToolCall(projectPath, toolUseId) {
    pendingApprovals.update(list => list.filter(a => a.toolUseId !== toolUseId));
    await window.api.chat.approveToolCall(projectPath, toolUseId, true);
}

export async function rejectToolCall(projectPath, toolUseId) {
    pendingApprovals.update(list => list.filter(a => a.toolUseId !== toolUseId));
    await window.api.chat.approveToolCall(projectPath, toolUseId, false);
}

export async function sendMessage(projectPath, text, mentions = []) {
    activeProjectPath = projectPath;
    pendingScreenshots = [];
    messages.update(msgs => [...msgs, { role: 'user', content: text, mentions }]);
    streaming.set(true);
    streamingText.set('');
    activeTools.set([]);
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
        pendingChangeSummary = null;
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
    pendingChangeSummary = null;
}

export async function clearChat(projectPath) {
    await window.api.chat.clear(projectPath);
    activeProjectPath = projectPath;
    messages.set([]);
    streamingText.set('');
    activeTools.set([]);
    pendingScreenshots = [];
    sessionUsage.set({ inputTokens: 0, outputTokens: 0, estimatedCost: 0 });
    sessionCredits.set(0);
    activeConversationId.set(null);
    await refreshConversationList(projectPath);
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
    messages.set(mergeToolMessages(history || []));
    activeConversationId.set(null);
    refreshConversationList(projectPath);

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

}

export async function refreshMentionIndex(projectPath) {
    const index = await window.api.chat.getMentions(projectPath);
    mentionIndex.set(index);
}

export async function refreshConversationList(projectPath) {
    try {
        const list = await window.api.chat.listConversations(projectPath);
        conversationList.set(list || []);
    } catch {
        conversationList.set([]);
    }
}

export async function loadPastConversation(projectPath, conversationId) {
    const history = await window.api.chat.loadConversation(projectPath, conversationId);
    messages.set(mergeToolMessages(history || []));
    activeConversationId.set(null); // now the active conversation, no longer archived
    sessionUsage.set({ inputTokens: 0, outputTokens: 0, estimatedCost: 0 });
    sessionCredits.set(0);

    try {
        const session = await window.api.chat.getSessionContext?.(projectPath);
        if (session?.mode === 'cloud' || session?.mode === 'byok') {
            aiMode.set(session.mode);
            await updateSetting('defaultAiMode', session.mode);
            if (session.mode === 'byok') {
                if (session.providerId) await updateSetting('aiProvider', session.providerId);
                if (session.modelId) await updateSetting('aiModel', session.modelId);
            } else if (session.mode === 'cloud' && session.modelId) {
                await updateSetting('cloudAiModel', session.modelId);
            }
            if (session.mode === 'cloud') await loadCredits();
        }
    } catch {
        // Session context may not be available
    }

    await refreshConversationList(projectPath);
}

export async function deletePastConversation(projectPath, conversationId) {
    await window.api.chat.deleteConversation(projectPath, conversationId);
    await refreshConversationList(projectPath);
}

export async function deleteAllPastConversations(projectPath) {
    await window.api.chat.deleteAllConversations(projectPath);
    messages.set([]);
    activeConversationId.set(null);
    sessionUsage.set({ inputTokens: 0, outputTokens: 0, estimatedCost: 0 });
    conversationList.set([]);
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

/**
 * Merge adjacent assistant messages from agentic tool loops on history load.
 * Tool-only assistant messages (those with toolCalls but no meaningful text content)
 * are folded into the next assistant message that has text content, so the conversation
 * renders the same way it did during the live streaming session.
 */
function mergeToolMessages(msgs) {
    if (!msgs || msgs.length === 0) return msgs;
    const merged = [];
    let pendingTools = [];
    let pendingScreenshots = [];

    for (const msg of msgs) {
        if (msg.role === 'assistant' && !msg.isError) {
            const hasText = msg.content && msg.content.trim() && msg.content.trim() !== 'Completed.';
            const hasTools = msg.toolCalls?.length > 0;

            if (hasTools && !hasText) {
                // Tool-only message: accumulate its tools and screenshots
                pendingTools.push(...msg.toolCalls);
                if (msg.screenshots?.length) pendingScreenshots.push(...msg.screenshots);
                continue;
            }

            if (hasText && pendingTools.length > 0) {
                // Text message following tool-only messages: merge everything
                merged.push({
                    ...msg,
                    toolCalls: [...pendingTools, ...(msg.toolCalls || [])],
                    screenshots: [...pendingScreenshots, ...(msg.screenshots || [])]
                });
                pendingTools = [];
                pendingScreenshots = [];
                continue;
            }
        }

        // Flush any pending tool-only messages that weren't followed by a text assistant message
        if (pendingTools.length > 0) {
            merged.push({
                role: 'assistant',
                content: '',
                toolCalls: pendingTools,
                screenshots: pendingScreenshots
            });
            pendingTools = [];
            pendingScreenshots = [];
        }

        // Fold changeSummary and executionReceipt into the preceding assistant message
        if (msg.role === 'system' && (msg.type === 'changeSummary' || msg.type === 'executionReceipt')) {
            const lastMsg = merged[merged.length - 1];
            if (lastMsg?.role === 'assistant' && !lastMsg.isError) {
                if (msg.type === 'changeSummary') {
                    lastMsg.changeSummary = {
                        label: msg.label,
                        timestamp: msg.timestamp,
                        added: msg.added || [],
                        modified: msg.modified || [],
                        deleted: msg.deleted || [],
                        snapshotId: msg.snapshotId
                    };
                }
                // executionReceipt is dropped entirely
                continue;
            }
        }

        merged.push(msg);
    }

    // Flush remaining
    if (pendingTools.length > 0) {
        merged.push({
            role: 'assistant',
            content: '',
            toolCalls: pendingTools,
            screenshots: pendingScreenshots
        });
    }

    return merged;
}
