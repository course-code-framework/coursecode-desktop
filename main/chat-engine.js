import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync, unlinkSync, renameSync } from 'fs';
import { createHash, randomBytes } from 'crypto';
import { app } from 'electron';
import { join, resolve, dirname } from 'path';
import { createProvider, loadApiKey, estimateCost, getCloudModels, getProviderModels } from './llm-provider.js';
import { loadToken } from './cloud-client.js';
import { buildSystemPrompt } from './system-prompts.js';
import { getSetting } from './settings.js';
import { startPreview, getPreviewStatus } from './preview-manager.js';
import { getMcpClient, getMcpTools } from './mcp-client.js';
import { listRefs, readRef } from './ref-manager.js';
import { createSnapshot, getChanges } from './snapshot-manager.js';
import { createLogger } from './logger.js';
import { translateChatError } from './errors.js';
import {
    FILE_TOOL_DEFINITIONS, TOOL_LABELS, PREVIEW_TOOLS, DEFAULT_PROVIDER,
    TOOL_RESULT_MAX_CHARS, STATE_TOOL_MAX_CHARS, MCP_TOOL_TRUNCATION_NOTE,
    OLDER_MESSAGE_MAX_CHARS,
    SAFE_TOOLS, MUTATION_TOOLS, PARALLELIZABLE_TOOLS,
    getMaxContextChars, COST_WARNING_THRESHOLDS, CREDIT_LOW_THRESHOLD
} from './ai-config.js';

const log = createLogger('chat');

const MENTION_TOTAL_MAX_CHARS = 12000;
const MENTION_REF_MAX_CHARS = 6000;
const MENTION_SLIDE_MAX_CHARS = 4500;
const MENTION_INTERACTION_MAX_CHARS = 4500;
const CHAT_TRACE_PREVIEW_CHARS = 280;
const MAX_AGENTIC_LOOP_ITERATIONS = 25;
const FILE_MUTATION_TOOLS = new Set(['edit_file', 'create_file']);
const verboseAiDiagnostics = !app.isPackaged && /^(1|true|yes)$/i.test(String(process.env.COURSECODE_VERBOSE_AI_DIAGNOSTICS || '0'));
const NOISY_CHAT_TRACE_STEPS = new Set([
    'stream-text-delta',
    'prepared-api-messages',
    'llm-request-start',
    'llm-loop-continue'
]);

function inferCloudProviderFromModelId(modelId) {
    const id = String(modelId || '').toLowerCase();
    if (!id) return null;
    if (id.includes('claude')) return 'anthropic';
    if (id.includes('gemini')) return 'google';
    if (id.includes('gpt') || id.includes('codex') || /^o\d/.test(id)) return 'openai';
    return null;
}

function inferCloudApiType(modelId, provider) {
    if (provider !== 'openai') return null;
    const id = String(modelId || '').toLowerCase();
    if (id.includes('codex') || /^gpt-5(\.|-|$)/.test(id)) return 'responses';
    return 'chat';
}

// --- Active conversations by projectPath ---
const conversations = new Map();
const conversationSessions = new Map();

// --- Active abort controllers ---
const abortControllers = new Map();

// --- Pending tool approvals ---
const pendingApprovals = new Map(); // key: `${projectPath}:${toolUseId}` → { resolve, reject }

// --- Build API messages with truncation ---

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function truncateContent(content) {
    if (typeof content !== 'string') content = JSON.stringify(content);
    if (content.length <= TOOL_RESULT_MAX_CHARS) return content;
    return content.slice(0, TOOL_RESULT_MAX_CHARS) + MCP_TOOL_TRUNCATION_NOTE;
}

function truncateText(text, maxChars = OLDER_MESSAGE_MAX_CHARS) {
    if (typeof text !== 'string') return text;
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}\n...[truncated for context efficiency]`;
}

function estimateContentChars(content) {
    if (typeof content === 'string') return content.length;
    if (Array.isArray(content)) {
        return content.reduce((sum, block) => {
            if (!block) return sum;
            if (typeof block.text === 'string') return sum + block.text.length;
            if (typeof block.content === 'string') return sum + block.content.length;
            return sum + JSON.stringify(block).length;
        }, 0);
    }
    return JSON.stringify(content || '').length;
}

function compactMessageContent(content, isRecent) {
    if (isRecent) return content;
    if (typeof content === 'string') return truncateText(content);
    if (Array.isArray(content)) {
        return content.map(block => {
            if (!block || typeof block !== 'object') return block;
            if (block.type === 'text' && typeof block.text === 'string') {
                return { ...block, text: truncateText(block.text) };
            }
            if (typeof block.content === 'string') {
                return { ...block, content: truncateText(block.content) };
            }
            return block;
        });
    }
    return content;
}

function stripImageBlocks(contentBlocks) {
    if (!Array.isArray(contentBlocks)) return contentBlocks;
    return contentBlocks.map(block => {
        if (block.type === 'image') {
            return { type: 'text', text: '[screenshot was shown to user]' };
        }
        return block;
    });
}

function prepareApiMessages(messages, maxContextChars) {
    const contextBudget = maxContextChars || getMaxContextChars();
    const apiMessages = [];
    const lastIndex = messages.length - 1;
    let contextChars = 0;

    for (let i = 0; i <= lastIndex; i++) {
        const m = messages[i];
        const isRecent = i >= lastIndex - 3; // keep the last few messages untruncated

        if (m.role === 'user') {
            // Skip empty user messages (Anthropic rejects them)
            const isEmpty = !m.content || (Array.isArray(m.content) && m.content.length === 0);
            if (isEmpty) continue;
            const compacted = compactMessageContent(m.content, isRecent);
            const messageChars = estimateContentChars(compacted);
            if (!isRecent && contextChars + messageChars > contextBudget) continue;
            contextChars += messageChars;
            apiMessages.push({ role: 'user', content: compacted });
        } else if (m.role === 'assistant') {
            if (m._raw) {
                const raw = { ...m._raw };
                if (Array.isArray(raw.content)) {
                    // Strip base64 images from older assistant messages
                    if (!isRecent) {
                        raw.content = stripImageBlocks(raw.content);
                    }
                    // Filter out empty text blocks (Anthropic rejects them)
                    raw.content = raw.content.filter(block =>
                        block.type !== 'text' || (block.text && block.text.length > 0)
                    );
                    // Skip if nothing left after filtering
                    if (raw.content.length === 0) continue;
                    if (!isRecent) {
                        raw.content = raw.content.map(block => {
                            if (block.type === 'text' && block.text) {
                                return { ...block, text: truncateText(block.text) };
                            }
                            return block;
                        });
                    }
                }
                const messageChars = estimateContentChars(raw.content);
                if (!isRecent && contextChars + messageChars > contextBudget) continue;
                contextChars += messageChars;
                apiMessages.push(raw);
            } else if (m.content) {
                const compacted = compactMessageContent(m.content, isRecent);
                const messageChars = estimateContentChars(compacted);
                if (!isRecent && contextChars + messageChars > contextBudget) continue;
                contextChars += messageChars;
                apiMessages.push({ role: 'assistant', content: compacted });
            }
        } else if (m.role === 'tool') {
            const contentStr = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
            const toolResult = {
                type: 'tool_result',
                tool_use_id: m.tool_use_id,
                content: isRecent ? contentStr : truncateContent(contentStr)
            };
            if (m.is_error) toolResult.is_error = true;

            // Merge consecutive tool_results into one user message
            const prev = apiMessages[apiMessages.length - 1];
            if (prev && prev.role === 'user' && Array.isArray(prev.content) &&
                prev.content.length > 0 && prev.content[0]?.type === 'tool_result') {
                prev.content.push(toolResult);
            } else {
                apiMessages.push({ role: 'user', content: [toolResult] });
            }
        }
    }
    return apiMessages;
}

/**
 * Translate internal Anthropic-format messages to OpenAI wire format.
 * Called only when the cloud model's upstream provider is OpenAI.
 */
function prepareOpenAIMessages(messages, maxContextChars) {
    const anthropicMsgs = prepareApiMessages(messages, maxContextChars);
    const out = [];

    for (const m of anthropicMsgs) {
        if (m.role === 'user') {
            // User messages may contain tool_result blocks (Anthropic format)
            if (Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result')) {
                for (const block of m.content) {
                    if (block.type === 'tool_result') {
                        out.push({
                            role: 'tool',
                            tool_call_id: block.tool_use_id,
                            content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content || {})
                        });
                    } else if (block.type === 'text' && block.text?.trim()) {
                        out.push({ role: 'user', content: block.text });
                    }
                }
            } else {
                const text = typeof m.content === 'string' ? m.content
                    : Array.isArray(m.content)
                        ? m.content.filter(b => b.type === 'text' && b.text?.trim()).map(b => b.text).join('\n\n')
                        : JSON.stringify(m.content);
                if (text) out.push({ role: 'user', content: text });
            }
            continue;
        }

        if (m.role === 'assistant') {
            if (Array.isArray(m.content)) {
                const textParts = m.content.filter(b => b.type === 'text' && b.text?.trim()).map(b => b.text);
                const toolUses = m.content.filter(b => b.type === 'tool_use');

                if (toolUses.length > 0) {
                    out.push({
                        role: 'assistant',
                        content: textParts.length > 0 ? textParts.join('\n\n') : '',
                        tool_calls: toolUses.map(tc => ({
                            id: tc.id,
                            type: 'function',
                            function: { name: tc.name, arguments: JSON.stringify(tc.input || {}) }
                        }))
                    });
                } else if (textParts.length > 0) {
                    out.push({ role: 'assistant', content: textParts.join('\n\n') });
                }
            } else if (typeof m.content === 'string') {
                out.push({ role: 'assistant', content: m.content });
            }
            continue;
        }

        // Pass through any other roles
        out.push(m);
    }

    return out;
}

/**
 * Resolve a tool name from the preceding assistant message's tool_use blocks.
 * tool_result blocks only carry tool_use_id — the actual name lives on the
 * assistant message that triggered the call.
 */
function resolveToolName(apiMessages, toolUseId) {
    for (let i = apiMessages.length - 1; i >= 0; i--) {
        const m = apiMessages[i];
        if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
        for (const block of m.content) {
            if (block.type === 'tool_use' && block.id === toolUseId) return block.name;
        }
    }
    return null;
}

/**
 * Translate internal Anthropic-format messages to Gemini wire format.
 * Called only when the cloud model's upstream provider is Google.
 */
function prepareGoogleMessages(messages, maxContextChars) {
    const anthropicMsgs = prepareApiMessages(messages, maxContextChars);
    const contents = [];

    for (const m of anthropicMsgs) {
        if (m.role === 'user') {
            const parts = [];
            if (Array.isArray(m.content)) {
                for (const block of m.content) {
                    if (block.type === 'text' && block.text?.trim()) {
                        parts.push({ text: block.text });
                    }
                    if (block.type === 'tool_result' && block.tool_use_id) {
                        const raw = typeof block.content === 'string' ? block.content : JSON.stringify(block.content || {});
                        let responseData;
                        try {
                            responseData = JSON.parse(raw);
                        } catch (err) {
                            responseData = { result: raw };
                            log.debug('Failed to parse tool_result for Gemini payload, using raw fallback', {
                                toolUseId: block.tool_use_id,
                                error: err?.message
                            });
                        }
                        parts.push({
                            functionResponse: {
                                name: resolveToolName(anthropicMsgs, block.tool_use_id) || block.tool_use_id,
                                response: responseData
                            }
                        });
                    }
                }
            } else if (typeof m.content === 'string' && m.content.trim()) {
                parts.push({ text: m.content });
            }
            if (parts.length > 0) contents.push({ role: 'user', parts });
            continue;
        }

        if (m.role === 'assistant') {
            const parts = [];
            if (Array.isArray(m.content)) {
                for (const block of m.content) {
                    if (block.type === 'text' && block.text?.trim()) {
                        parts.push({ text: block.text });
                    }
                    if (block.type === 'tool_use' && block.name) {
                        const part = {
                            functionCall: { name: block.name, args: block.input || {} }
                        };
                        if (block.thought_signature) part.thoughtSignature = block.thought_signature;
                        parts.push(part);
                    }
                }
            } else if (typeof m.content === 'string' && m.content.trim()) {
                parts.push({ text: m.content });
            }
            if (parts.length > 0) contents.push({ role: 'model', parts });
            continue;
        }
    }

    return contents;
}

/**
 * Translate internal Anthropic-format messages to OpenAI Responses API input format.
 * Called only when the cloud model uses apiType === 'responses' (Codex models).
 *
 * Responses API input items:
 * - { role: "user", content: "..." }  (simple text messages)
 * - { role: "assistant", content: "..." }  (assistant text)
 * - { type: "function_call", call_id: "...", name: "...", arguments: "..." }
 * - { type: "function_call_output", call_id: "...", output: "..." }
 */
function prepareOpenAIResponsesInput(messages, maxContextChars) {
    const anthropicMsgs = prepareApiMessages(messages, maxContextChars);
    const input = [];

    for (const m of anthropicMsgs) {
        if (m.role === 'user') {
            if (Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result')) {
                for (const block of m.content) {
                    if (block.type === 'tool_result') {
                        input.push({
                            type: 'function_call_output',
                            call_id: block.tool_use_id,
                            output: typeof block.content === 'string' ? block.content : JSON.stringify(block.content || {})
                        });
                    } else if (block.type === 'text' && block.text?.trim()) {
                        input.push({ role: 'user', content: block.text });
                    }
                }
            } else {
                const text = typeof m.content === 'string' ? m.content
                    : Array.isArray(m.content)
                        ? m.content.filter(b => b.type === 'text' && b.text?.trim()).map(b => b.text).join('\n\n')
                        : JSON.stringify(m.content);
                if (text) input.push({ role: 'user', content: text });
            }
            continue;
        }

        if (m.role === 'assistant') {
            if (Array.isArray(m.content)) {
                const textParts = m.content.filter(b => b.type === 'text' && b.text?.trim()).map(b => b.text);
                const toolUses = m.content.filter(b => b.type === 'tool_use');

                // Emit text content as a message
                if (textParts.length > 0) {
                    input.push({ role: 'assistant', content: textParts.join('\n\n') });
                }
                // Emit each tool call as a function_call item
                for (const tc of toolUses) {
                    input.push({
                        type: 'function_call',
                        call_id: tc.id,
                        name: tc.name,
                        arguments: JSON.stringify(tc.input || {})
                    });
                }
            } else if (typeof m.content === 'string') {
                input.push({ role: 'assistant', content: m.content });
            }
            continue;
        }

        // Pass through any other items
        input.push(m);
    }

    return input;
}

// --- Conversation persistence ---

function getChatDir(projectPath) {
    const projectId = createHash('sha256').update(resolve(projectPath)).digest('hex');
    return join(app.getPath('userData'), 'chat-history', projectId);
}

function getConversationPath(projectPath) {
    return join(getChatDir(projectPath), 'conversation.json');
}

function getLegacyChatDir(projectPath) {
    return join(projectPath, '.chat');
}

function migrateLegacyChatStorage(projectPath) {
    const legacyDir = getLegacyChatDir(projectPath);
    if (!existsSync(legacyDir)) return;

    const nextChatDir = getChatDir(projectPath);
    if (!existsSync(nextChatDir)) mkdirSync(nextChatDir, { recursive: true });

    const legacyConversation = join(legacyDir, 'conversation.json');
    const nextConversation = getConversationPath(projectPath);

    try {
        if (existsSync(legacyConversation) && !existsSync(nextConversation)) {
            writeFileSync(nextConversation, readFileSync(legacyConversation, 'utf-8'));
        }
        rmSync(legacyDir, { recursive: true, force: true });
    } catch (err) {
        log.warn('Failed migrating legacy project-local chat storage', err);
    }
}

function normalizeSessionContext(session) {
    if (!session || typeof session !== 'object') return null;
    const mode = session.mode === 'cloud' ? 'cloud' : session.mode === 'byok' ? 'byok' : null;
    if (!mode) return null;

    const providerId = typeof session.providerId === 'string' && session.providerId.trim()
        ? session.providerId.trim()
        : null;
    const modelId = typeof session.modelId === 'string' && session.modelId.trim()
        ? session.modelId.trim()
        : null;

    return {
        mode,
        providerId,
        modelId,
        updatedAt: session.updatedAt || null
    };
}

function loadConversationState(projectPath) {
    migrateLegacyChatStorage(projectPath);
    const convPath = getConversationPath(projectPath);
    if (!existsSync(convPath)) return { messages: [], session: null };
    try {
        const data = JSON.parse(readFileSync(convPath, 'utf-8'));
        return {
            messages: Array.isArray(data.messages) ? data.messages : [],
            session: normalizeSessionContext(data.session)
        };
    } catch (err) {
        log.warn('Failed to load conversation', err);
        return { messages: [], session: null };
    }
}

function loadConversation(projectPath) {
    return loadConversationState(projectPath).messages;
}

function saveConversation(projectPath, messages, session) {
    const chatDir = getChatDir(projectPath);
    if (!existsSync(chatDir)) mkdirSync(chatDir, { recursive: true });
    writeFileSync(
        getConversationPath(projectPath),
        JSON.stringify({ messages, session: normalizeSessionContext(session), savedAt: new Date().toISOString() }, null, 2)
    );
}

function serializeConversation(messages = []) {
    return messages.map(m => ({
        role: m.role,
        content: m.content,
        _display: m._display,
        _mentions: m._mentions,
        _toolCalls: m._toolCalls,
        _usage: m._usage,
        _raw: m._raw,
        tool_use_id: m.tool_use_id,
        is_error: m.is_error
    }));
}

function persistConversation(projectPath, messages, sessionOverride) {
    const nextSession = normalizeSessionContext(
        sessionOverride !== undefined
            ? sessionOverride
            : (conversationSessions.get(projectPath) || loadConversationState(projectPath).session)
    );
    conversations.set(projectPath, messages);
    if (nextSession) conversationSessions.set(projectPath, nextSession);
    else conversationSessions.delete(projectPath);

    saveConversation(projectPath, serializeConversation(messages), nextSession);
}

// --- Conversation history (multi-conversation support) ---

function getConversationsDir(projectPath) {
    return join(getChatDir(projectPath), 'conversations');
}

function getConversationsIndexPath(projectPath) {
    return join(getConversationsDir(projectPath), 'index.json');
}

function loadConversationsIndex(projectPath) {
    const indexPath = getConversationsIndexPath(projectPath);
    if (!existsSync(indexPath)) return [];
    try {
        const data = JSON.parse(readFileSync(indexPath, 'utf-8'));
        return Array.isArray(data) ? data : [];
    } catch {
        return [];
    }
}

function saveConversationsIndex(projectPath, index) {
    const dir = getConversationsDir(projectPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(getConversationsIndexPath(projectPath), JSON.stringify(index, null, 2));
}

function deriveConversationTitle(messages) {
    const firstUserMsg = messages.find(m => m.role === 'user');
    if (!firstUserMsg) return 'Untitled conversation';
    const text = typeof firstUserMsg.content === 'string'
        ? firstUserMsg.content
        : (firstUserMsg._display || JSON.stringify(firstUserMsg.content));
    const cleaned = text.replace(/\s+/g, ' ').trim();
    return cleaned.length > 60 ? cleaned.slice(0, 57) + '…' : cleaned;
}

function archiveActiveConversation(projectPath) {
    const convPath = getConversationPath(projectPath);
    if (!existsSync(convPath)) return null;

    let data;
    try {
        data = JSON.parse(readFileSync(convPath, 'utf-8'));
    } catch {
        return null;
    }

    const msgs = Array.isArray(data.messages) ? data.messages : [];
    if (msgs.length === 0) return null;

    const id = randomBytes(4).toString('hex');
    const dir = getConversationsDir(projectPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    // Move active conversation to archive
    const archivePath = join(dir, `${id}.json`);
    renameSync(convPath, archivePath);

    // Update index
    const session = normalizeSessionContext(data.session);
    const summary = {
        id,
        title: deriveConversationTitle(msgs),
        updatedAt: data.savedAt || new Date().toISOString(),
        messageCount: msgs.filter(m => m.role === 'user' || m.role === 'assistant').length,
        mode: session?.mode || 'byok'
    };

    const index = loadConversationsIndex(projectPath);
    index.unshift(summary);
    saveConversationsIndex(projectPath, index);

    return id;
}

function toolReason(toolName) {
    switch (toolName) {
        case 'coursecode_state':
            return 'Confirm current slide structure before editing';
        case 'read_file':
            return 'Inspect existing course content to preserve intent';
        case 'edit_file':
            return 'Apply targeted changes to course content';
        case 'create_file':
            return 'Create a new course file';
        case 'coursecode_screenshot':
            return 'Validate learner-facing visuals after edits';

        case 'coursecode_navigate':
            return 'Open the affected slide for targeted validation';
        case 'coursecode_interact':
            return 'Test interaction behavior from a learner perspective';
        case 'coursecode_build':
            return 'Confirm the course can be packaged for LMS delivery';
        default:
            return 'Collect context needed for the requested update';
    }
}

// --- @ mention resolution ---

function resolveMentions(projectPath, message, mentions = []) {
    if (!mentions.length) return message;

    const contextParts = [];
    let totalChars = 0;
    const appendMentionContext = (label, rawContent, maxPerMention) => {
        if (!rawContent) return;
        const remaining = MENTION_TOTAL_MAX_CHARS - totalChars;
        if (remaining <= 0) return;

        const clipped = String(rawContent).slice(0, Math.min(maxPerMention, remaining));
        if (!clipped.trim()) return;

        contextParts.push(`${label}\n${clipped}`);
        totalChars += clipped.length;
    };

    for (const mention of mentions) {
        try {
            if (mention.type === 'slide') {
                const slidePath = join(projectPath, 'course', 'slides', `${mention.id}.js`);
                if (existsSync(slidePath)) {
                    const content = readFileSync(slidePath, 'utf-8');
                    appendMentionContext(
                        `[Referenced slide: "${mention.title}"]`,
                        content,
                        MENTION_SLIDE_MAX_CHARS
                    );
                }
            } else if (mention.type === 'ref') {
                const { content } = readRef(projectPath, mention.filename);
                appendMentionContext(
                    `[Referenced document: "${mention.filename}"]`,
                    content,
                    MENTION_REF_MAX_CHARS
                );
            } else if (mention.type === 'interaction') {
                const assessmentFiles = readdirSync(join(projectPath, 'course', 'assessments')).filter(f => f.endsWith('.js'));
                for (const file of assessmentFiles) {
                    const content = readFileSync(join(projectPath, 'course', 'assessments', file), 'utf-8');
                    if (content.includes(mention.id)) {
                        appendMentionContext(
                            `[Referenced interaction: "${mention.id}"]`,
                            content,
                            MENTION_INTERACTION_MAX_CHARS
                        );
                        break;
                    }
                }
            }
        } catch (err) {
            log.debug(`Failed to resolve mention ${mention.type}:${mention.id || mention.filename}`, err);
        }
    }

    if (contextParts.length) {
        return message + '\n\n---\n' + contextParts.join('\n\n');
    }
    return message;
}

/** Names of the desktop-managed file tools — MCP versions are ignored. */
const LOCAL_FILE_TOOLS = new Set(['read_file', 'edit_file', 'create_file', 'list_files', 'list_directory', 'write_file']);

/** MCP tools excluded from the AI tool surface (build-only lint is redundant when preview is always running). */
const EXCLUDED_MCP_TOOLS = new Set(['coursecode_lint']);

function mergeToolDefinitions(fileTools = [], discoveredTools = []) {
    // Start with the desktop's file tools (always present, execute locally).
    const merged = [...fileTools];
    const byName = new Map(merged.map(t => [t.name, t]));

    // Add MCP-discovered tools, skipping any that collide with local file tools.
    for (const tool of discoveredTools) {
        const name = tool?.name;
        if (!name) continue;
        if (LOCAL_FILE_TOOLS.has(name)) continue; // desktop handles file I/O
        if (EXCLUDED_MCP_TOOLS.has(name)) continue; // build-only lint redundant with preview running

        const normalized = {
            name,
            description: tool.description || `CourseCode tool: ${name}`,
            input_schema: tool.inputSchema || tool.input_schema || { type: 'object', properties: {} }
        };

        byName.set(name, normalized);
        merged.push(normalized);
    }

    return merged;
}

const FILE_TOOLS = new Set(['read_file', 'edit_file', 'create_file', 'list_files', 'search_files']);

function sanitizeToolResultForModel(toolName, result) {
    if (toolName === 'coursecode_screenshot' && result?.content && Array.isArray(result.content)) {
        // Pass the full content (including image blocks) to the model so it can
        // actually see what it rendered. Strip only non-essential metadata.
        return result.content;
    }

    const safeJson = JSON.stringify(result, (key, value) => {
        if ((key === 'data' || key === 'base64') && typeof value === 'string' && value.length > 160) {
            return `[omitted binary data: ${value.length} chars]`;
        }
        return value;
    });

    // File tools return small, predictable results — no truncation needed.
    // MCP tools can return unpredictable output, so apply limits.
    if (FILE_TOOLS.has(toolName)) return safeJson;

    // coursecode_state is the AI's primary orientation tool — give it a higher limit
    if (toolName === 'coursecode_state') {
        if (safeJson.length <= STATE_TOOL_MAX_CHARS) return safeJson;
        return safeJson.slice(0, STATE_TOOL_MAX_CHARS) + MCP_TOOL_TRUNCATION_NOTE;
    }

    if (safeJson.length <= TOOL_RESULT_MAX_CHARS) return safeJson;
    return safeJson.slice(0, TOOL_RESULT_MAX_CHARS) + MCP_TOOL_TRUNCATION_NOTE;
}

function toPreviewText(value, maxChars = CHAT_TRACE_PREVIEW_CHARS) {
    let text;
    if (typeof value === 'string') {
        text = value;
    } else {
        try {
            text = JSON.stringify(value);
        } catch (err) {
            text = String(value);
            log.debug('Failed to stringify value for chat trace preview', err);
        }
    }

    if (!text) return '';
    const singleLine = text.replace(/\s+/g, ' ').trim();
    if (singleLine.length <= maxChars) return singleLine;
    return `${singleLine.slice(0, maxChars)}...`;
}

function summarizeApiMessage(message) {
    if (!message || typeof message !== 'object') return { kind: 'unknown' };

    if (message.type === 'function_call') {
        return {
            kind: 'function_call',
            callId: message.call_id,
            name: message.name,
            argsPreview: toPreviewText(message.arguments)
        };
    }

    if (message.type === 'function_call_output') {
        return {
            kind: 'function_call_output',
            callId: message.call_id,
            outputPreview: toPreviewText(message.output)
        };
    }

    const summary = { kind: 'message', role: message.role || 'unknown' };

    if (typeof message.content === 'string') {
        summary.textPreview = toPreviewText(message.content);
        return summary;
    }

    if (Array.isArray(message.content)) {
        summary.blockTypes = message.content.map(block => block?.type || 'unknown');
        const textParts = message.content
            .filter(block => block?.type === 'text' && typeof block.text === 'string')
            .map(block => block.text)
            .join(' ');
        if (textParts) summary.textPreview = toPreviewText(textParts);
        const toolCalls = message.content
            .filter(block => block?.type === 'tool_use')
            .map(block => ({ id: block.id, name: block.name, inputPreview: toPreviewText(block.input) }));
        if (toolCalls.length > 0) summary.toolCalls = toolCalls;
        return summary;
    }

    if (Array.isArray(message.parts)) {
        summary.parts = message.parts.map(part => {
            if (part?.text) return { type: 'text', preview: toPreviewText(part.text) };
            if (part?.functionCall) {
                return {
                    type: 'functionCall',
                    name: part.functionCall.name,
                    argsPreview: toPreviewText(part.functionCall.args),
                    thoughtSignature: Boolean(part.thoughtSignature)
                };
            }
            if (part?.functionResponse) {
                return {
                    type: 'functionResponse',
                    name: part.functionResponse.name,
                    responsePreview: toPreviewText(part.functionResponse.response)
                };
            }
            return { type: 'unknown' };
        });
    }

    if (Array.isArray(message.tool_calls)) {
        summary.toolCalls = message.tool_calls.map(call => ({
            id: call.id,
            name: call.function?.name,
            argsPreview: toPreviewText(call.function?.arguments)
        }));
    }

    return summary;
}

function logChatTrace(projectPath, step, details = {}) {
    if (app.isPackaged) return;
    if (!verboseAiDiagnostics && NOISY_CHAT_TRACE_STEPS.has(step)) return;
    log.debug(`[chat-trace] ${step}`, { projectPath, ...details });
}

function createRequestId() {
    return `chat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// --- Tool execution ---

/**
 * Resolve a pending tool approval from the renderer.
 */
export function resolveToolApproval(projectPath, toolUseId, approved) {
    const key = `${projectPath}:${toolUseId}`;
    const pending = pendingApprovals.get(key);
    if (pending) {
        pendingApprovals.delete(key);
        pending.resolve(approved);
    }
}

/**
 * Wait for user approval of a tool call. Returns true if approved, false if rejected.
 */
function waitForToolApproval(projectPath, toolUseId, webContents, tc) {
    return new Promise((resolve) => {
        const key = `${projectPath}:${toolUseId}`;
        pendingApprovals.set(key, { resolve });

        webContents?.send('chat:toolApproval', {
            projectPath,
            toolUseId,
            tool: tc.name,
            label: TOOL_LABELS[tc.name] || tc.name,
            input: tc.input,
            filePath: tc.input?.path || undefined
        });
    });
}

/**
 * Check if a tool call needs user approval based on the current toolApprovalMode setting.
 */
function needsApproval(toolName) {
    const mode = getSetting('toolApprovalMode') || 'auto';
    if (mode === 'auto') return false;
    if (mode === 'all') return true;
    if (mode === 'mutations') return MUTATION_TOOLS.has(toolName);
    return false;
}

async function executeTool(toolName, toolInput, projectPath, webContents) {
    // File tools resolve paths relative to the course/ directory, not the project root.
    // The AI only works with course content — it never needs to touch package.json, node_modules, etc.
    const courseRoot = resolve(projectPath, 'course');
    const resolveToolPath = (candidatePath) => {
        if (typeof candidatePath !== 'string' || !candidatePath.trim()) {
            throw new Error('Tool path must be a non-empty string');
        }
        const target = resolve(courseRoot, candidatePath);
        if (target !== courseRoot && !target.startsWith(`${courseRoot}\\`) && !target.startsWith(`${courseRoot}/`)) {
            throw new Error(`Path must be inside the course directory: ${candidatePath}`);
        }
        return target;
    };

    // File operations (paths relative to course/)
    if (toolName === 'read_file') {
        const filePath = resolveToolPath(toolInput.path);
        if (!existsSync(filePath)) {
            let hint = '';
            const baseName = toolInput.path.replace(/.*[\/\\]/, '').replace(/\.js$/, '');
            const slidePath = resolve(courseRoot, 'slides', `${baseName}.js`);
            if (existsSync(slidePath)) {
                hint = ` Did you mean slides/${baseName}.js?`;
            } else {
                hint = ' Use list_files to discover the correct path.';
            }
            return { error: `File not found: ${toolInput.path}.${hint}` };
        }
        const fullContent = readFileSync(filePath, 'utf-8');
        const lines = fullContent.split('\n');
        const totalLines = lines.length;
        const startLine = Math.max(1, Math.min(toolInput.start_line || 1, totalLines));
        const endLine = Math.min(toolInput.end_line || totalLines, totalLines);
        const selected = lines.slice(startLine - 1, endLine);
        const content = selected.join('\n');
        const result = { content, totalLines };
        if (startLine > 1 || endLine < totalLines) {
            result.range = { start: startLine, end: endLine };
            if (endLine < totalLines) result.truncatedAfterLine = endLine;
        }
        return result;
    }

    if (toolName === 'edit_file') {
        const filePath = resolveToolPath(toolInput.path);
        if (!existsSync(filePath)) return { error: `File not found: ${toolInput.path}. Use list_files to discover the correct path.` };
        if (toolInput.old_string === toolInput.new_string) return { error: `old_string and new_string are identical — no change would be made. Check that you are replacing the correct text.` };
        const content = readFileSync(filePath, 'utf-8');
        const occurrences = content.split(toolInput.old_string).length - 1;
        if (occurrences === 0) return { error: `old_string not found in ${toolInput.path}. Read the file first to see current content.` };
        if (occurrences > 1) return { error: `old_string matches ${occurrences} locations in ${toolInput.path}. Include more surrounding lines to uniquely identify the target.` };
        const updated = content.replace(toolInput.old_string, toolInput.new_string);
        writeFileSync(filePath, updated);
        return { success: true, path: toolInput.path };
    }

    if (toolName === 'create_file') {
        const filePath = resolveToolPath(toolInput.path);
        if (existsSync(filePath)) return { error: `File already exists: ${toolInput.path}. Use edit_file to modify existing files.` };
        const dir = dirname(filePath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(filePath, toolInput.content);
        return { success: true, path: toolInput.path };
    }

    if (toolName === 'search_files') {
        const MAX_MATCHES = 50;
        const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.mp4', '.mp3', '.wav', '.ogg', '.zip', '.tar', '.gz', '.woff', '.woff2', '.ttf', '.eot', '.pdf']);
        const searchRoot = resolveToolPath(toolInput.path || '.');
        if (!existsSync(searchRoot)) return { error: `Path not found: ${toolInput.path || '.'}` };

        let regex;
        try {
            regex = new RegExp(toolInput.is_regex ? toolInput.pattern : escapeRegExp(toolInput.pattern), 'i');
        } catch (e) {
            return { error: `Invalid regex pattern: ${e.message}` };
        }

        const matches = [];
        const stat = statSync(searchRoot);
        const filesToSearch = [];

        if (stat.isFile()) {
            filesToSearch.push(searchRoot);
        } else {
            const walk = (dir) => {
                for (const entry of readdirSync(dir, { withFileTypes: true })) {
                    if (entry.name.startsWith('.')) continue;
                    const full = resolve(dir, entry.name);
                    if (entry.isDirectory()) {
                        if (entry.name === 'node_modules') continue;
                        walk(full);
                    } else {
                        const ext = entry.name.includes('.') ? '.' + entry.name.split('.').pop().toLowerCase() : '';
                        if (!BINARY_EXT.has(ext)) filesToSearch.push(full);
                    }
                }
            };
            walk(searchRoot);
        }

        for (const file of filesToSearch) {
            if (matches.length >= MAX_MATCHES) break;
            try {
                const content = readFileSync(file, 'utf-8');
                const lines = content.split('\n');
                const relPath = file.substring(courseRoot.length + 1).replace(/\\/g, '/');
                for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
                    if (regex.test(lines[i])) {
                        matches.push({ file: relPath, line: i + 1, text: lines[i].trim() });
                    }
                }
            } catch { /* skip unreadable files */ }
        }

        if (matches.length === 0) return { matches: [], message: `No matches found for "${toolInput.pattern}".` };
        const result = { matches };
        if (matches.length >= MAX_MATCHES) result.truncated = true;
        return result;
    }

    if (toolName === 'list_files') {
        const dirPath = resolveToolPath(toolInput.path || '.');
        if (!existsSync(dirPath)) return { error: `Directory not found: ${toolInput.path || '.'}` };
        const entries = readdirSync(dirPath, { withFileTypes: true });
        const HIDDEN = new Set(['.DS_Store', 'thumbs.db']);
        const BINARY_LIST_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.mp4', '.mp3', '.wav', '.ogg', '.zip', '.tar', '.gz', '.woff', '.woff2', '.ttf', '.eot', '.pdf']);
        return {
            files: entries
                .filter(e => !HIDDEN.has(e.name) && !e.name.startsWith('.'))
                .map(e => {
                    const info = { name: e.name, type: e.isDirectory() ? 'directory' : 'file' };
                    if (!e.isDirectory()) {
                        const ext = e.name.includes('.') ? '.' + e.name.split('.').pop().toLowerCase() : '';
                        if (!BINARY_LIST_EXT.has(ext)) {
                            try {
                                const content = readFileSync(resolve(dirPath, e.name), 'utf-8');
                                info.lines = content.split('\n').length;
                            } catch { /* skip unreadable */ }
                        }
                    }
                    return info;
                })
        };
    }

    // MCP-bridged tools (require preview server)
    if (PREVIEW_TOOLS.has(toolName)) {
        // Auto-start preview if needed
        if (getPreviewStatus(projectPath) !== 'running') {
            webContents?.send('chat:toolUse', {
                projectPath,
                tool: toolName,
                label: 'Starting preview server…',
                status: 'running'
            });
            await startPreview(projectPath, webContents);
        }
    }

    // Delegate to the MCP server via stdio JSON-RPC
    try {
        const mcp = await getMcpClient(projectPath);
        const result = await mcp.callTool(toolName, toolInput);

        // MCP tools/call returns { content: [...] } — parse it
        if (result?.content && Array.isArray(result.content)) {
            // Check for error responses
            if (result.isError) {
                const text = result.content.map(c => c.text || '').join('');
                return { error: text || 'Tool returned an error' };
            }
            // Return the full content array (may include text + image blocks)
            return result;
        }

        return result || { error: 'No response from MCP tool' };
    } catch (err) {
        return { error: err.message };
    }
}

// --- Build project context for system prompt ---

function getProjectContext(projectPath) {
    const context = {};
    try {
        // Read course config for title and structure
        const configPath = join(projectPath, 'course', 'course-config.js');
        if (existsSync(configPath)) {
            const configContent = readFileSync(configPath, 'utf-8');
            // Extract title from config (rough parse)
            const titleMatch = configContent.match(/title:\s*['"]([^'"]+)['"]/);
            if (titleMatch) context.title = titleMatch[1];

            // Extract slide IDs/titles from structure
            const slides = [];
            const slideMatches = configContent.matchAll(/id:\s*['"]([^'"]+)['"].*?title:\s*['"]([^'"]+)['"]/gs);
            for (const match of slideMatches) {
                slides.push({ id: match[1], title: match[2], type: 'slide' });
            }
            if (slides.length) context.slides = slides;
        }
    } catch (err) { log.debug('Failed to read course-config for context', err); }

    // Reference docs
    try {
        const refs = listRefs(projectPath);
        if (refs.length) context.refs = refs.map(r => r.filename);
    } catch (err) { log.debug('Failed to list refs for context', err); }

    return context;
}

// --- Mention index building ---

export function buildMentionIndex(projectPath) {
    const index = { slides: [], refs: [], interactions: [] };

    // Slides from course-config
    try {
        const configPath = join(projectPath, 'course', 'course-config.js');
        if (existsSync(configPath)) {
            const content = readFileSync(configPath, 'utf-8');
            const matches = content.matchAll(/id:\s*['"]([^'"]+)['"].*?title:\s*['"]([^'"]+)['"]/gs);
            for (const match of matches) {
                index.slides.push({ id: match[1], title: match[2], type: 'slide' });
            }
        }
    } catch (err) { log.debug('Failed to read course-config for mentions', err); }

    // Reference docs
    try {
        const refs = listRefs(projectPath);
        for (const ref of refs) {
            index.refs.push({ filename: ref.filename, type: 'ref' });
        }
    } catch (err) { log.debug('Failed to list refs for mentions', err); }

    // Interactions from assessment files
    try {
        const assessDir = join(projectPath, 'course', 'assessments');
        if (existsSync(assessDir)) {
            const files = readdirSync(assessDir).filter(f => f.endsWith('.js'));
            for (const file of files) {
                const content = readFileSync(join(assessDir, file), 'utf-8');
                const matches = content.matchAll(/id:\s*['"]([^'"]+)['"]/g);
                for (const match of matches) {
                    index.interactions.push({ id: match[1], type: 'interaction', file });
                }
            }
        }
    } catch (err) { log.debug('Failed to read assessments for mentions', err); }

    return index;
}

// --- Main chat flow ---

export async function sendMessage(projectPath, userMessage, mentions, webContents, mode) {
    // Resolve provider based on mode
    const isCloud = mode === 'cloud';
    const providerId = isCloud ? 'cloud' : (getSetting('aiProvider') || DEFAULT_PROVIDER);
    let modelId = isCloud ? getSetting('cloudAiModel') : getSetting('aiModel');

    log.info(`sendMessage → ${providerId}/${modelId}`, { mode, hasMentions: mentions?.length > 0 });

    let credential;
    let cloudProvider = null;
    let cloudApiType = null;
    if (isCloud) {
        credential = loadToken();
        if (!credential) {
            webContents?.send('chat:error', {
                projectPath,
                message: 'Not signed in to CourseCode Cloud. Sign in from Settings or the Dashboard.'
            });
            return;
        }

        try {
            const availableCloudModels = await getCloudModels(credential);
            const availableIds = new Set((availableCloudModels || []).map(m => m.id));
            if (!modelId && availableCloudModels.length > 0) {
                modelId = availableCloudModels[0].id;
                log.info('No cloud model configured, defaulting to first available cloud model', { fallback: modelId });
            } else if (availableIds.size > 0 && !availableIds.has(modelId)) {
                const fallbackCloudModel = availableCloudModels[0].id;
                log.info('Cloud model not available, falling back to first available model', { requested: modelId, fallback: fallbackCloudModel });
                modelId = fallbackCloudModel;
            }

            // Resolve the upstream provider for the selected cloud model
            const selectedModel = (availableCloudModels || []).find(m => m.id === modelId);
            if (selectedModel?.provider) {
                cloudProvider = selectedModel.provider;
                cloudApiType = selectedModel.apiType || null;
                log.debug('Resolved cloud provider', { modelId, cloudProvider, cloudApiType });
            }

            if (!modelId) {
                webContents?.send('chat:error', {
                    projectPath,
                    message: 'No cloud AI models are currently available for your account.'
                });
                return;
            }
        } catch (err) {
            log.debug('Failed to validate cloud model against available models, continuing with configured/default model', err);
            if (!modelId) {
                webContents?.send('chat:error', {
                    projectPath,
                    message: 'Unable to load cloud AI models right now. Try again in a moment.'
                });
                return;
            }
        }

        // If cloud model metadata couldn't be resolved (e.g., temporary model API failure),
        // infer provider/api type from model ID so request formatting stays valid.
        if (!cloudProvider && modelId) {
            const inferredProvider = inferCloudProviderFromModelId(modelId);
            const inferredApiType = inferCloudApiType(modelId, inferredProvider);
            if (inferredProvider) {
                cloudProvider = inferredProvider;
                cloudApiType = inferredApiType;
                log.warn('Cloud provider metadata unavailable; using model-id inference fallback', {
                    modelId,
                    cloudProvider,
                    cloudApiType
                });
            } else {
                log.warn('Cloud provider metadata unavailable and inference failed', { modelId });
            }
        }

        if (!cloudProvider) {
            webContents?.send('chat:error', {
                projectPath,
                message: 'Unable to determine cloud model format right now. Open Settings → AI and reselect your cloud model, then try again.'
            });
            return;
        }
    } else {
        credential = loadApiKey(providerId);
        if (!credential) {
            webContents?.send('chat:error', {
                projectPath,
                message: 'No API key configured. Go to Settings → AI to add your API key.'
            });
            return;
        }

        const providerModels = getProviderModels(providerId);
        const modelIds = new Set((providerModels || []).map(m => m.id));
        if (modelIds.size > 0 && !modelIds.has(modelId)) {
            const defaultProviderModel = providerModels.find(m => m.default)?.id || providerModels[0]?.id;
            if (defaultProviderModel) {
                log.info('BYOK model not available for provider, falling back to provider default', { providerId, requested: modelId, fallback: defaultProviderModel });
                modelId = defaultProviderModel;
            }
        }

        if (!modelId) {
            modelId = providerModels.find(m => m.default)?.id || providerModels[0]?.id;
            if (modelId) {
                log.info('Using BYOK fallback model', { providerId, fallback: modelId });
            }
        }

        if (!modelId) {
            webContents?.send('chat:error', {
                projectPath,
                message: 'No AI models are available for this provider yet. Add a key and refresh models in Settings.'
            });
            return;
        }
    }

    // Load or init conversation
    let messages = conversations.get(projectPath);
    if (!messages) {
        const state = loadConversationState(projectPath);
        messages = state.messages;
        conversations.set(projectPath, messages);
        if (state.session) conversationSessions.set(projectPath, state.session);
    }

    const sessionContext = {
        mode: isCloud ? 'cloud' : 'byok',
        providerId,
        modelId,
        updatedAt: new Date().toISOString()
    };
    const requestId = createRequestId();
    const trace = (step, details = {}) => logChatTrace(projectPath, step, { requestId, ...details });
    log.info('Chat turn started', {
        projectPath,
        requestId,
        mode: sessionContext.mode,
        providerId,
        modelId
    });

    // Resolve mentions and append user message
    const resolvedMessage = resolveMentions(projectPath, userMessage, mentions);
    messages.push({ role: 'user', content: resolvedMessage, _display: userMessage, _mentions: mentions });
    persistConversation(projectPath, messages, sessionContext);
    trace('user-message-appended', {
        mode: sessionContext.mode,
        providerId,
        modelId,
        mentionCount: Array.isArray(mentions) ? mentions.length : 0,
        userPreview: toPreviewText(userMessage),
        resolvedPreview: toPreviewText(resolvedMessage),
        conversationLength: messages.length
    });

    // Set up abort controller
    const controller = new AbortController();
    abortControllers.set(projectPath, controller);

    // Build system prompt with project context
    const projectContext = getProjectContext(projectPath);
    const systemPrompt = buildSystemPrompt(projectContext);

    // Build API messages with truncation for efficiency
    // For cloud models, translate to the upstream provider's wire format
    const maxContextChars = getMaxContextChars(modelId);
    let apiMessages;
    if (cloudApiType === 'responses') {
        apiMessages = prepareOpenAIResponsesInput(messages, maxContextChars);
    } else if (cloudProvider === 'openai') {
        apiMessages = prepareOpenAIMessages(messages, maxContextChars);
    } else if (cloudProvider === 'google') {
        apiMessages = prepareGoogleMessages(messages, maxContextChars);
    } else {
        apiMessages = prepareApiMessages(messages, maxContextChars);
    }
    trace('prepared-api-messages', {
        mode: sessionContext.mode,
        providerId,
        modelId,
        cloudProvider,
        cloudApiType,
        totalMessages: apiMessages.length,
        recentMessages: apiMessages.slice(-4).map(summarizeApiMessage)
    });

    try {
        const provider = await createProvider(providerId, credential, { cloudProvider, cloudApiType });
        let runtimeTools = [...FILE_TOOL_DEFINITIONS];
        if (getPreviewStatus(projectPath) === 'running') {
            const discoveredTools = await getMcpTools(projectPath);
            runtimeTools = mergeToolDefinitions(FILE_TOOL_DEFINITIONS, discoveredTools);
        }
        log.debug('Provider created, starting agentic loop');
        let sessionInputTokens = 0;
        let sessionOutputTokens = 0;
        let sessionCreditsCharged = 0;
        let sessionCacheCreation = 0;
        let sessionCacheRead = 0;
        let executedToolCount = 0;
        let successfulToolCount = 0;
        let failedToolCount = 0;
        let mutationToolAttempts = 0;
        let mutationToolSuccesses = 0;
        let detectedChangedFiles = null;

        // Agentic loop: keep calling LLM until it stops requesting tools
        let continueLoop = true;
        let loopIteration = 0;
        let hadToolErrors = false;
        // Auto-snapshot before AI starts making changes
        const chatIndex = messages.length - 1; // Index of the user message
        try { await createSnapshot(projectPath, 'Before AI changes', { chatIndex }); } catch (err) { log.debug('Pre-AI snapshot failed (repo may not be initialized)', err); }

        while (continueLoop) {
            continueLoop = false;
            loopIteration += 1;

            if (loopIteration > MAX_AGENTIC_LOOP_ITERATIONS) {
                trace('llm-loop-guard-triggered', {
                    loopIteration,
                    maxIterations: MAX_AGENTIC_LOOP_ITERATIONS,
                    recentMessages: apiMessages.slice(-4).map(summarizeApiMessage)
                });
                throw new Error('The AI requested too many consecutive tool steps without finishing. Please try again with a more specific request.');
            }

            const MAX_TIMEOUT_RETRIES = 1;
            let timeoutRetries = 0;
            let didTimeout = false;

            // Retry wrapper: re-issues the same LLM call on upstream timeout (once)
            do {
            didTimeout = false;

            log.debug('Calling LLM', { messageCount: apiMessages.length, model: modelId, timeoutRetry: timeoutRetries > 0 ? timeoutRetries : undefined });
            trace('llm-request-start', {
                loopIteration,
                mode: sessionContext.mode,
                providerId,
                modelId,
                messageCount: apiMessages.length,
                toolCount: runtimeTools.length,
                tools: runtimeTools.map(t => t.name),
                recentMessages: apiMessages.slice(-4).map(summarizeApiMessage),
                timeoutRetry: timeoutRetries > 0 ? timeoutRetries : undefined
            });
            const stream = provider.chat({
                messages: apiMessages,
                tools: runtimeTools,
                system: systemPrompt,
                model: modelId,
                signal: controller.signal,
                requestId
            });

            let currentText = '';
            let currentToolCalls = [];
            let toolInputJson = '';
            let currentToolId = null;
            let currentToolName = null;
            const toolStartById = new Map();

            for await (const event of stream) {
                if (controller.signal.aborted) break;

                if (event.type === 'text') {
                    currentText += event.text;
                    webContents?.send('chat:stream', { projectPath, text: currentText, delta: event.text });
                    // Per-token deltas only logged when COURSECODE_VERBOSE_AI_DIAGNOSTICS=1
                    trace('stream-text-delta', {
                        deltaChars: event.text?.length || 0,
                        totalChars: currentText.length,
                        preview: toPreviewText(event.text)
                    });
                } else if (event.type === 'tool_use_start') {
                    currentToolId = event.id;
                    currentToolName = event.name;
                    toolInputJson = '';
                    toolStartById.set(event.id, Date.now());
                    // Gemini 2.5+ models include a thought_signature that must be preserved
                    if (event.thought_signature) toolStartById.set(`${event.id}_sig`, event.thought_signature);
                    webContents?.send('chat:toolUse', {
                        projectPath,
                        tool: event.name,
                        toolUseId: event.id,
                        label: TOOL_LABELS[event.name] || `Using ${event.name}…`,
                        status: 'running',
                        startedAt: Date.now(),
                        reason: toolReason(event.name)
                    });
                    trace('tool-call-start', {
                        toolUseId: event.id,
                        tool: event.name,
                        reason: toolReason(event.name)
                    });
                } else if (event.type === 'tool_use_delta') {
                    toolInputJson += event.json;
                    webContents?.send('chat:toolArgsDelta', {
                        projectPath,
                        toolUseId: currentToolId,
                        delta: event.json,
                        accumulated: toolInputJson
                    });
                } else if (event.type === 'content_block_stop') {
                    if (currentToolId && currentToolName) {
                        let toolInput = {};
                        try { toolInput = JSON.parse(toolInputJson); } catch (err) { log.debug('Failed to parse tool input JSON (may be partial)', err); }
                        currentToolCalls.push({
                            id: currentToolId,
                            name: currentToolName,
                            input: toolInput,
                            startedAt: toolStartById.get(currentToolId) || Date.now(),
                            thought_signature: toolStartById.get(`${currentToolId}_sig`) || null
                        });
                        trace('tool-call-ready', {
                            toolUseId: currentToolId,
                            tool: currentToolName,
                            inputPreview: toPreviewText(toolInput)
                        });
                        currentToolId = null;
                        currentToolName = null;
                        toolInputJson = '';
                    }
                } else if (event.type === 'done') {
                    sessionInputTokens += event.usage?.inputTokens || 0;
                    sessionOutputTokens += event.usage?.outputTokens || 0;
                    sessionCreditsCharged += event.creditsCharged || 0;
                    sessionCacheCreation += event.usage?.cacheCreationInputTokens || 0;
                    sessionCacheRead += event.usage?.cacheReadInputTokens || 0;

                    // Cloud stream timeout — the upstream provider stopped responding.
                    // Any timeout is an error: partial text from a truncated stream is unreliable.
                    if (event.timedOut) {
                        if (timeoutRetries < MAX_TIMEOUT_RETRIES) {
                            timeoutRetries += 1;
                            didTimeout = true;
                            log.warn('Cloud stream timed out, retrying', { streamedChars: currentText.length, toolCalls: currentToolCalls.length, retry: timeoutRetries });
                            // Clear any partial streamed text from the UI before retry
                            webContents?.send('chat:stream', { projectPath, text: '', delta: '', retry: true });
                            break; // break out of the event loop to re-issue the LLM call
                        }
                        log.warn('Cloud stream timed out after retry', { streamedChars: currentText.length, toolCalls: currentToolCalls.length });
                        throw new Error('The AI service timed out before finishing its response. Try again.');
                    }

                    trace('llm-response-complete', {
                        stopReason: event.stopReason,
                        timedOut: Boolean(event.timedOut),
                        streamedChars: currentText.length,
                        usage: event.usage,
                        creditsCharged: event.creditsCharged || 0,
                        assistantPreview: toPreviewText(currentText),
                        toolCalls: currentToolCalls.map(tc => ({
                            id: tc.id,
                            name: tc.name,
                            inputPreview: toPreviewText(tc.input)
                        }))
                    });

                    // Store assistant message
                    const assistantContent = [];
                    if (currentText) {
                        assistantContent.push({ type: 'text', text: currentText });
                    }
                    for (const tc of currentToolCalls) {
                        const toolBlock = { type: 'tool_use', id: tc.id, name: tc.name, input: tc.input };
                        if (tc.thought_signature) toolBlock.thought_signature = tc.thought_signature;
                        assistantContent.push(toolBlock);
                    }

                    const assistantMsg = {
                        role: 'assistant',
                        content: currentText,
                        _raw: assistantContent.length > 0
                            ? { role: 'assistant', content: assistantContent }
                            : undefined,
                        _toolCalls: currentToolCalls.map(tc => ({
                            id: tc.id,
                            name: tc.name,
                            label: TOOL_LABELS[tc.name],
                            filePath: tc.input?.path || undefined,
                            reason: toolReason(tc.name),
                            status: 'running'
                        })),
                        _usage: { ...event.usage, creditsCharged: event.creditsCharged || 0 }
                    };
                    messages.push(assistantMsg);
                    if (assistantContent.length > 0) {
                        if (cloudApiType === 'responses') {
                            // Responses API format: separate items for text and function_calls
                            const textParts = assistantContent.filter(b => b.type === 'text').map(b => b.text);
                            const toolUses = assistantContent.filter(b => b.type === 'tool_use');
                            if (textParts.length > 0) {
                                apiMessages.push({ role: 'assistant', content: textParts.join('\n\n') });
                            }
                            for (const tc of toolUses) {
                                apiMessages.push({
                                    type: 'function_call',
                                    call_id: tc.id,
                                    name: tc.name,
                                    arguments: JSON.stringify(tc.input || {})
                                });
                            }
                        } else if (cloudProvider === 'openai') {
                            // OpenAI format: tool_calls on the assistant message, text as string
                            const toolUses = assistantContent.filter(b => b.type === 'tool_use');
                            const textParts = assistantContent.filter(b => b.type === 'text').map(b => b.text);
                            const openaiMsg = {
                                role: 'assistant',
                                content: textParts.length > 0 ? textParts.join('\n\n') : null
                            };
                            if (toolUses.length > 0) {
                                openaiMsg.tool_calls = toolUses.map(tc => ({
                                    id: tc.id,
                                    type: 'function',
                                    function: { name: tc.name, arguments: JSON.stringify(tc.input || {}) }
                                }));
                            }
                            apiMessages.push(openaiMsg);
                        } else if (cloudProvider === 'google') {
                            // Gemini format: role 'model' with functionCall parts
                            const parts = [];
                            for (const block of assistantContent) {
                                if (block.type === 'text' && block.text?.trim()) parts.push({ text: block.text });
                                if (block.type === 'tool_use') {
                                    const part = { functionCall: { name: block.name, args: block.input || {} } };
                                    if (block.thought_signature) part.thoughtSignature = block.thought_signature;
                                    parts.push(part);
                                }
                            }
                            if (parts.length > 0) apiMessages.push({ role: 'model', parts });
                        } else {
                            apiMessages.push({ role: 'assistant', content: assistantContent });
                        }
                    }
                    persistConversation(projectPath, messages, sessionContext);

                    // Execute tool calls — parallel for safe tools, sequential for mutations.
                    if (currentToolCalls.length > 0) {
                        const toolResults = [];

                        // Partition into parallelizable (read-only) and sequential (mutation) groups
                        const parallelBatch = [];
                        const sequentialQueue = [];
                        for (const tc of currentToolCalls) {
                            if (PARALLELIZABLE_TOOLS.has(tc.name) && !needsApproval(tc.name)) {
                                parallelBatch.push(tc);
                            } else {
                                sequentialQueue.push(tc);
                            }
                        }

                        // Execute parallel batch concurrently
                        if (parallelBatch.length > 1) {
                            const parallelResults = await Promise.all(parallelBatch.map(async (tc) => {
                                executedToolCount += 1;
                                trace('tool-execution-start', { toolUseId: tc.id, tool: tc.name, parallel: true });
                                try {
                                    const result = await executeTool(tc.name, tc.input, projectPath, webContents);
                                    const finishedAt = Date.now();
                                    const elapsedMs = Math.max(0, finishedAt - (tc.startedAt || finishedAt));
                                    const isToolError = result && typeof result === 'object' && 'error' in result && !result.success;

                                    if (tc.name === 'coursecode_screenshot' && result?.content) {
                                        const imageContent = Array.isArray(result.content)
                                            ? result.content.find(c => c.type === 'image') : null;
                                        if (imageContent) {
                                            webContents?.send('chat:screenshot', {
                                                projectPath,
                                                imageData: imageContent.source?.data || imageContent.data
                                            });
                                        }
                                    }

                                    webContents?.send('chat:toolUse', {
                                        projectPath, tool: tc.name, toolUseId: tc.id,
                                        label: TOOL_LABELS[tc.name] || tc.name,
                                        status: isToolError ? 'error' : 'done',
                                        finishedAt, elapsedMs, reason: toolReason(tc.name),
                                        filePath: tc.input?.path || undefined,
                                        detail: tc.input?.path || tc.input?.slideId || undefined
                                    });
                                    if (isToolError) {
                                        hadToolErrors = true;
                                        failedToolCount += 1;
                                    } else {
                                        successfulToolCount += 1;
                                    }
                                    return {
                                        meta: { id: tc.id, name: tc.name, status: isToolError ? 'error' : 'done', elapsedMs, filePath: tc.input?.path, detail: tc.input?.path || tc.input?.slideId, reason: toolReason(tc.name) },
                                        type: 'tool_result', tool_use_id: tc.id,
                                        content: sanitizeToolResultForModel(tc.name, result),
                                        is_error: isToolError || undefined
                                    };
                                } catch (err) {
                                    hadToolErrors = true;
                                    failedToolCount += 1;
                                    const finishedAt = Date.now();
                                    const elapsedMs = Math.max(0, finishedAt - (tc.startedAt || finishedAt));
                                    webContents?.send('chat:toolUse', {
                                        projectPath, tool: tc.name, toolUseId: tc.id,
                                        label: TOOL_LABELS[tc.name] || tc.name, status: 'error',
                                        finishedAt, elapsedMs, reason: toolReason(tc.name),
                                        filePath: tc.input?.path || undefined
                                    });
                                    return {
                                        meta: { id: tc.id, name: tc.name, status: 'error', elapsedMs, filePath: tc.input?.path, reason: toolReason(tc.name) },
                                        type: 'tool_result', tool_use_id: tc.id,
                                        content: JSON.stringify({ error: err.message }), is_error: true
                                    };
                                }
                            }));
                            toolResults.push(...parallelResults);
                        } else if (parallelBatch.length === 1) {
                            // Single item, just add to sequential queue
                            sequentialQueue.unshift(parallelBatch[0]);
                        }

                        // Execute sequential tools one at a time (with approval if needed)
                        for (const tc of sequentialQueue) {
                            executedToolCount += 1;
                            if (FILE_MUTATION_TOOLS.has(tc.name)) mutationToolAttempts += 1;

                            // Check if this tool needs user approval
                            if (needsApproval(tc.name)) {
                                webContents?.send('chat:toolUse', {
                                    projectPath, tool: tc.name, toolUseId: tc.id,
                                    label: TOOL_LABELS[tc.name] || tc.name,
                                    status: 'pending_approval',
                                    startedAt: Date.now(),
                                    reason: toolReason(tc.name),
                                    filePath: tc.input?.path || undefined,
                                    detail: tc.input?.path || tc.input?.slideId || undefined,
                                    input: tc.input
                                });

                                const approved = await waitForToolApproval(projectPath, tc.id, webContents, tc);
                                if (!approved) {
                                    webContents?.send('chat:toolUse', {
                                        projectPath, tool: tc.name, toolUseId: tc.id,
                                        label: TOOL_LABELS[tc.name] || tc.name, status: 'skipped',
                                        reason: 'User declined'
                                    });
                                    toolResults.push({
                                        meta: { id: tc.id, name: tc.name, status: 'skipped', reason: 'User declined' },
                                        type: 'tool_result', tool_use_id: tc.id,
                                        content: JSON.stringify({ skipped: true, reason: 'User declined this tool call' }),
                                        is_error: true
                                    });
                                    continue;
                                }
                            }

                            log.debug(`Executing tool: ${tc.name}`);
                            trace('tool-execution-start', {
                                toolUseId: tc.id,
                                tool: tc.name,
                                inputPreview: toPreviewText(tc.input)
                            });
                            try {
                                const result = await executeTool(tc.name, tc.input, projectPath, webContents);
                                const finishedAt = Date.now();
                                const elapsedMs = Math.max(0, finishedAt - (tc.startedAt || finishedAt));

                                // Detect tool-level errors returned as data (not thrown)
                                const isToolError = result && typeof result === 'object' && 'error' in result && !result.success;

                                // Special handling for screenshots
                                if (tc.name === 'coursecode_screenshot' && result?.content) {
                                    const imageContent = Array.isArray(result.content)
                                        ? result.content.find(c => c.type === 'image')
                                        : null;
                                    if (imageContent) {
                                        webContents?.send('chat:screenshot', {
                                            projectPath,
                                            imageData: imageContent.source?.data || imageContent.data
                                        });
                                    }
                                }

                                webContents?.send('chat:toolUse', {
                                    projectPath,
                                    tool: tc.name,
                                    toolUseId: tc.id,
                                    label: TOOL_LABELS[tc.name] || tc.name,
                                    status: isToolError ? 'error' : 'done',
                                    finishedAt,
                                    elapsedMs,
                                    reason: toolReason(tc.name),
                                    filePath: tc.input?.path || undefined,
                                    detail: tc.input?.path || tc.input?.slideId || undefined
                                });

                                trace('tool-execution-done', {
                                    toolUseId: tc.id,
                                    tool: tc.name,
                                    elapsedMs,
                                    isToolError,
                                    outputPreview: toPreviewText(result)
                                });

                                if (isToolError) {
                                    hadToolErrors = true;
                                    failedToolCount += 1;
                                } else {
                                    successfulToolCount += 1;
                                    if (FILE_MUTATION_TOOLS.has(tc.name)) mutationToolSuccesses += 1;
                                }

                                toolResults.push({
                                    meta: {
                                        id: tc.id,
                                        name: tc.name,
                                        status: isToolError ? 'error' : 'done',
                                        elapsedMs,
                                        filePath: tc.input?.path || undefined,
                                        detail: tc.input?.path || tc.input?.slideId || undefined,
                                        reason: toolReason(tc.name)
                                    },
                                    type: 'tool_result',
                                    tool_use_id: tc.id,
                                    content: sanitizeToolResultForModel(tc.name, result),
                                    is_error: isToolError || undefined
                                });
                            } catch (err) {
                                log.warn(`Tool execution failed: ${tc.name}`, err);
                                hadToolErrors = true;
                                failedToolCount += 1;
                                const finishedAt = Date.now();
                                const elapsedMs = Math.max(0, finishedAt - (tc.startedAt || finishedAt));
                                webContents?.send('chat:toolUse', {
                                    projectPath,
                                    tool: tc.name,
                                    toolUseId: tc.id,
                                    label: TOOL_LABELS[tc.name] || tc.name,
                                    status: 'error',
                                    finishedAt,
                                    elapsedMs,
                                    reason: toolReason(tc.name),
                                    filePath: tc.input?.path || undefined,
                                    detail: tc.input?.path || tc.input?.slideId || undefined
                                });

                                trace('tool-execution-error', {
                                    toolUseId: tc.id,
                                    tool: tc.name,
                                    elapsedMs,
                                    error: err?.message || String(err)
                                });

                                toolResults.push({
                                    meta: {
                                        id: tc.id,
                                        name: tc.name,
                                        status: 'error',
                                        elapsedMs,
                                        filePath: tc.input?.path || undefined,
                                        detail: tc.input?.path || tc.input?.slideId || undefined,
                                        reason: toolReason(tc.name)
                                    },
                                    type: 'tool_result',
                                    tool_use_id: tc.id,
                                    content: JSON.stringify({ error: err.message }),
                                    is_error: true
                                });
                            }
                        }

                        // Add tool results to conversation
                        const toolMetaById = new Map();
                        const toolResultContents = [];
                        for (const tr of toolResults) {
                            if (tr.meta?.id) toolMetaById.set(tr.meta.id, tr.meta);
                            const toolResultMessage = {
                                type: 'tool_result',
                                tool_use_id: tr.tool_use_id,
                                content: tr.content
                            };
                            if (tr.is_error) toolResultMessage.is_error = true;
                            messages.push({ role: 'tool', ...toolResultMessage });
                            toolResultContents.push(toolResultMessage);
                        }
                        if (toolResultContents.length > 0) {
                            if (cloudApiType === 'responses') {
                                // Responses API format: each tool result is a function_call_output item
                                for (const tr of toolResultContents) {
                                    const output = typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content || {});
                                    apiMessages.push({
                                        type: 'function_call_output',
                                        call_id: tr.tool_use_id,
                                        output
                                    });
                                }
                            } else if (cloudProvider === 'openai') {
                                // OpenAI format: each tool result is a separate { role: 'tool' } message
                                for (const tr of toolResultContents) {
                                    const content = typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content || {});
                                    apiMessages.push({
                                        role: 'tool',
                                        tool_call_id: tr.tool_use_id,
                                        content
                                    });
                                }
                            } else if (cloudProvider === 'google') {
                                // Gemini format: functionResponse parts in a user message
                                const parts = toolResultContents.map(tr => {
                                    const raw = typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content || {});
                                    let responseData;
                                    try {
                                        responseData = JSON.parse(raw);
                                    } catch (err) {
                                        responseData = { result: raw };
                                        log.debug('Failed to parse tool result for Gemini follow-up payload, using raw fallback', {
                                            toolUseId: tr.tool_use_id,
                                            error: err?.message
                                        });
                                    }
                                    const toolName = currentToolCalls.find(tc => tc.id === tr.tool_use_id)?.name || tr.tool_use_id;
                                    return {
                                        functionResponse: {
                                            name: toolName,
                                            response: responseData
                                        }
                                    };
                                });
                                apiMessages.push({ role: 'user', parts });
                            } else {
                                apiMessages.push({ role: 'user', content: toolResultContents });
                            }
                        }

                        // Backfill tool metadata on the assistant message that triggered these tool calls
                        const lastAssistant = messages.slice().reverse().find(m => m.role === 'assistant' && m._toolCalls?.length);
                        if (lastAssistant) {
                            lastAssistant._toolCalls = lastAssistant._toolCalls.map(tc => {
                                const meta = toolMetaById.get(tc.id || tc.toolUseId);
                                return meta ? { ...tc, ...meta } : tc;
                            });
                        }

                        persistConversation(projectPath, messages, sessionContext);

                        // Continue the loop — LLM needs to process tool results
                        continueLoop = true;
                        trace('llm-loop-continue', {
                            reason: 'tool-results-appended',
                            totalApiMessages: apiMessages.length,
                            recentMessages: apiMessages.slice(-4).map(summarizeApiMessage)
                        });
                        currentText = '';
                        currentToolCalls = [];
                    }
                    // Done is terminal for this stream — break to prevent duplicate processing
                    break;
                }

                if (controller.signal.aborted) break;
            }
            } while (didTimeout && !controller.signal.aborted);

            if (controller.signal.aborted) break;
        }

        // Save conversation
        persistConversation(projectPath, messages, sessionContext);

        log.info('Chat complete', {
            inputTokens: sessionInputTokens,
            outputTokens: sessionOutputTokens,
            cacheCreation: sessionCacheCreation || undefined,
            cacheRead: sessionCacheRead || undefined
        });

        // Auto-snapshot after AI changes & emit change summary
        try {
            const changes = await getChanges(projectPath);
            const totalChanged = (changes.added?.length || 0) + (changes.modified?.length || 0) + (changes.deleted?.length || 0);
            detectedChangedFiles = totalChanged;

            if (totalChanged > 0 && mutationToolSuccesses > 0) {
                // Get a summary label from the last assistant text
                const lastText = messages.filter(m => m.role === 'assistant' && m.content).pop()?.content || '';
                const summaryLabel = lastText.slice(0, 60).replace(/\n/g, ' ').trim() || 'Made changes';
                const snap = await createSnapshot(projectPath, `AI: ${summaryLabel}`, { chatIndex, files: changes });

                webContents?.send('chat:changeSummary', {
                    projectPath,
                    label: snap.label,
                    timestamp: snap.timestamp,
                    added: changes.added,
                    modified: changes.modified,
                    deleted: changes.deleted,
                    snapshotId: snap.id
                });
            } else if (totalChanged > 0) {
                log.debug('Change summary suppressed: diffs detected without successful mutation tool execution', {
                    requestId,
                    totalChanged,
                    mutationToolSuccesses,
                    mutationToolAttempts
                });
            }
        } catch (err) { log.debug('Post-AI snapshot failed', err); }

        // Done
        const cost = isCloud ? null : estimateCost(
            getSetting('aiProvider') || DEFAULT_PROVIDER,
            modelId,
            sessionInputTokens,
            sessionOutputTokens
        );

        const hasVerifiedFileChanges = mutationToolSuccesses > 0 && typeof detectedChangedFiles === 'number' && detectedChangedFiles > 0;

        let outcomeClass = 'no_changes';
        if (hasVerifiedFileChanges) {
            outcomeClass = 'verified_changes';
        } else if (failedToolCount > 0) {
            outcomeClass = 'tool_failures';
        } else if (executedToolCount === 0) {
            outcomeClass = 'model_text_only';
        }

        const execution = {
            totalToolCalls: executedToolCount,
            succeededToolCalls: successfulToolCount,
            failedToolCalls: failedToolCount,
            mutationToolAttempts,
            mutationToolSuccesses,
            changedFiles: detectedChangedFiles,
            hasVerifiedFileChanges,
            hasUnverifiedMutationOutcome: mutationToolAttempts > 0 && !hasVerifiedFileChanges,
            outcomeClass
        };

        trace('chat-execution-receipt', execution);

        const finalAssistantMessage = messages.filter(m => m.role === 'assistant' && m.content).pop()?.content || '';

        webContents?.send('chat:done', {
            projectPath,
            message: finalAssistantMessage,
            execution,
            usage: {
                inputTokens: sessionInputTokens,
                outputTokens: sessionOutputTokens,
                totalTokens: sessionInputTokens + sessionOutputTokens,
                estimatedCost: cost,
                creditsCharged: isCloud ? sessionCreditsCharged : undefined
            }
        });

        trace('chat-finished', {
            hadToolErrors,
            totalMessages: messages.length,
            usage: {
                inputTokens: sessionInputTokens,
                outputTokens: sessionOutputTokens,
                cacheCreation: sessionCacheCreation,
                cacheRead: sessionCacheRead,
                creditsCharged: sessionCreditsCharged
            },
            assistantPreview: toPreviewText(messages.filter(m => m.role === 'assistant' && m.content).pop()?.content || '')
        });

    } catch (err) {
        if (err.name === 'AbortError') {
            trace('chat-cancelled');
            return;
        }

        log.error('Chat flow failed', err);
        trace('chat-error', {
            message: err?.message || String(err),
            status: err?.status,
            code: err?.code,
            errorCode: err?.errorCode
        });
        persistConversation(projectPath, messages);
        const userMessage = translateChatError(err, isCloud);
        webContents?.send('chat:error', { projectPath, message: userMessage });
    } finally {
        abortControllers.delete(projectPath);
    }
}

export function stopGeneration(projectPath) {
    const controller = abortControllers.get(projectPath);
    if (controller) {
        controller.abort();
        abortControllers.delete(projectPath);
    }
}

export function clearConversation(projectPath) {
    // Archive the current conversation if it has messages, then start fresh
    archiveActiveConversation(projectPath);
    conversations.delete(projectPath);
    conversationSessions.delete(projectPath);
    // Note: context-memory.json is preserved across conversations
}

export function listConversations(projectPath) {
    migrateLegacyChatStorage(projectPath);
    return loadConversationsIndex(projectPath);
}

export function loadPastConversation(projectPath, conversationId) {
    // Archive current conversation first (if non-empty)
    archiveActiveConversation(projectPath);
    conversations.delete(projectPath);
    conversationSessions.delete(projectPath);

    const archivePath = join(getConversationsDir(projectPath), `${conversationId}.json`);
    if (!existsSync(archivePath)) return [];

    // Move the selected conversation back to active
    const convPath = getConversationPath(projectPath);
    renameSync(archivePath, convPath);

    // Remove from index
    const index = loadConversationsIndex(projectPath);
    const filtered = index.filter(entry => entry.id !== conversationId);
    saveConversationsIndex(projectPath, filtered);

    // Load it as the active conversation
    return loadHistory(projectPath);
}

export function deleteConversation(projectPath, conversationId) {
    const archivePath = join(getConversationsDir(projectPath), `${conversationId}.json`);
    if (existsSync(archivePath)) {
        unlinkSync(archivePath);
    }

    const index = loadConversationsIndex(projectPath);
    const filtered = index.filter(entry => entry.id !== conversationId);
    saveConversationsIndex(projectPath, filtered);
}

export function deleteAllConversations(projectPath) {
    // Delete all archived conversations and clear the index
    const dir = getConversationsDir(projectPath);
    if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
    }

    // Clear the active conversation
    const convPath = getConversationPath(projectPath);
    if (existsSync(convPath)) {
        unlinkSync(convPath);
    }

    conversations.delete(projectPath);
    conversationSessions.delete(projectPath);
}

export function deleteChatHistory(projectPath) {
    const chatDir = getChatDir(projectPath);
    if (existsSync(chatDir)) {
        rmSync(chatDir, { recursive: true, force: true });
    }
    conversations.delete(projectPath);
    conversationSessions.delete(projectPath);
}

export function loadHistory(projectPath) {
    const { messages, session } = loadConversationState(projectPath);
    conversations.set(projectPath, messages);
    if (session) conversationSessions.set(projectPath, session);
    else conversationSessions.delete(projectPath);
    return messages.map(m => ({
        role: m.role,
        content: m._display || m.content,
        toolCalls: m._toolCalls,
        usage: m._usage,
        mentions: m._mentions
    })).filter(m => m.role === 'user' || m.role === 'assistant');
}

export function getSessionContext(projectPath) {
    if (conversationSessions.has(projectPath)) {
        return conversationSessions.get(projectPath);
    }
    const { session } = loadConversationState(projectPath);
    if (session) conversationSessions.set(projectPath, session);
    return session;
}

export function resetConversationCache(projectPath, options = {}) {
    const { reloadFromDisk = false } = options;

    if (!reloadFromDisk) {
        conversations.delete(projectPath);
        conversationSessions.delete(projectPath);
        return;
    }

    const { messages, session } = loadConversationState(projectPath);
    conversations.set(projectPath, messages);
    if (session) conversationSessions.set(projectPath, session);
    else conversationSessions.delete(projectPath);
}
