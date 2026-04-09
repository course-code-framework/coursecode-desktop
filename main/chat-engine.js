import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, unlinkSync } from 'fs';
import { createHash } from 'crypto';
import { app } from 'electron';
import { join, resolve, dirname } from 'path';
import { createProvider, loadApiKey, estimateCost, getCloudModels, getProviderModels } from './llm-provider.js';
import { loadToken } from './cloud-client.js';
import { buildSystemPrompt, getToolDefinitions } from './system-prompts.js';
import { getSetting } from './settings.js';
import { startPreview, getPreviewStatus } from './preview-manager.js';
import { getMcpClient, getMcpTools } from './mcp-client.js';
import { listRefs, readRef } from './ref-manager.js';
import { createSnapshot, getChanges } from './snapshot-manager.js';
import { createLogger } from './logger.js';
import { translateChatError } from './errors.js';
import {
    TOOL_LABELS, PREVIEW_TOOLS, DEFAULT_PROVIDER, DEFAULT_MODEL, DEFAULT_CLOUD_MODEL,
    TOOL_RESULT_MAX_CHARS, TOOL_RESULT_TRUNCATION_NOTE,
    MAX_CONTEXT_CHARS, OLDER_MESSAGE_MAX_CHARS, FALLBACK_MODELS
} from './ai-config.js';

const log = createLogger('chat');

const MENTION_TOTAL_MAX_CHARS = 12000;
const MENTION_REF_MAX_CHARS = 6000;
const MENTION_SLIDE_MAX_CHARS = 4500;
const MENTION_INTERACTION_MAX_CHARS = 4500;

// --- Active conversations by projectPath ---
const conversations = new Map();
const conversationSessions = new Map();

// --- Active abort controllers ---
const abortControllers = new Map();

// --- Build API messages with truncation ---

function truncateContent(content) {
    if (typeof content !== 'string') content = JSON.stringify(content);
    if (content.length <= TOOL_RESULT_MAX_CHARS) return content;
    return content.slice(0, TOOL_RESULT_MAX_CHARS) + TOOL_RESULT_TRUNCATION_NOTE;
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

function prepareApiMessages(messages) {
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
            if (!isRecent && contextChars + messageChars > MAX_CONTEXT_CHARS) continue;
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
                if (!isRecent && contextChars + messageChars > MAX_CONTEXT_CHARS) continue;
                contextChars += messageChars;
                apiMessages.push(raw);
            } else if (m.content) {
                const compacted = compactMessageContent(m.content, isRecent);
                const messageChars = estimateContentChars(compacted);
                if (!isRecent && contextChars + messageChars > MAX_CONTEXT_CHARS) continue;
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
function prepareOpenAIMessages(messages) {
    const anthropicMsgs = prepareApiMessages(messages);
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
function prepareGoogleMessages(messages) {
    const anthropicMsgs = prepareApiMessages(messages);
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
                        try { responseData = JSON.parse(raw); } catch { responseData = { result: raw }; }
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
                        parts.push({
                            functionCall: { name: block.name, args: block.input || {} }
                        });
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

// --- Conversation persistence ---

function getChatDir(projectPath) {
    const projectId = createHash('sha256').update(resolve(projectPath)).digest('hex');
    return join(app.getPath('userData'), 'chat-history', projectId);
}

function getConversationPath(projectPath) {
    return join(getChatDir(projectPath), 'conversation.json');
}

function getMemoryPath(projectPath) {
    return join(getChatDir(projectPath), 'context-memory.json');
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
    const legacyMemory = join(legacyDir, 'context-memory.json');
    const nextConversation = getConversationPath(projectPath);
    const nextMemory = getMemoryPath(projectPath);

    try {
        if (existsSync(legacyConversation) && !existsSync(nextConversation)) {
            writeFileSync(nextConversation, readFileSync(legacyConversation, 'utf-8'));
        }
        if (existsSync(legacyMemory) && !existsSync(nextMemory)) {
            writeFileSync(nextMemory, readFileSync(legacyMemory, 'utf-8'));
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

function loadProjectMemory(projectPath) {
    migrateLegacyChatStorage(projectPath);
    const memoryPath = getMemoryPath(projectPath);
    if (!existsSync(memoryPath)) return null;
    try {
        return JSON.parse(readFileSync(memoryPath, 'utf-8'));
    } catch (err) {
        log.warn('Failed to load course memory', err);
        return null;
    }
}

function saveProjectMemory(projectPath, memory) {
    const chatDir = getChatDir(projectPath);
    if (!existsSync(chatDir)) mkdirSync(chatDir, { recursive: true });
    writeFileSync(getMemoryPath(projectPath), JSON.stringify(memory, null, 2));
}

function uniqueList(items = []) {
    return [...new Set(items.filter(Boolean).map(s => String(s).trim()).filter(Boolean))];
}

function deriveExecutionPlan(userMessage = '', projectContext = {}) {
    const text = userMessage.toLowerCase();
    const steps = [];

    steps.push({ id: 'inspect', label: 'Inspect course structure and references', status: 'pending' });

    if (text.includes('outline')) {
        steps.push({ id: 'author', label: 'Draft or refine the course outline', status: 'pending' });
    } else if (text.includes('quiz') || text.includes('assessment') || text.includes('interaction')) {
        steps.push({ id: 'author', label: 'Update learning interactions and assessment flow', status: 'pending' });
    } else if (text.includes('copy') || text.includes('wording') || text.includes('tone')) {
        steps.push({ id: 'author', label: 'Revise instructional copy and tone', status: 'pending' });
    } else if (projectContext.slides?.length) {
        steps.push({ id: 'author', label: 'Apply updates to relevant slides', status: 'pending' });
    } else {
        steps.push({ id: 'author', label: 'Create the requested course content', status: 'pending' });
    }

    steps.push({ id: 'verify', label: 'Verify visuals and run quality checks', status: 'pending' });
    steps.push({ id: 'summarize', label: 'Summarize outcomes and next authoring steps', status: 'pending' });
    return steps;
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
        case 'coursecode_lint':
            return 'Check course structure and content integrity';
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

function extractCourseMemory(messages = [], existing = null) {
    const userMessages = messages.filter(m => m.role === 'user').map(m => String(m._display || m.content || ''));
    const assistantMessages = messages.filter(m => m.role === 'assistant').map(m => String(m.content || ''));
    const recentUser = userMessages.slice(-20);
    const recentAssistant = assistantMessages.slice(-12);
    const textBlob = recentUser.join('\n').toLowerCase();
    const allBlob = `${recentUser.join('\n')}\n${recentAssistant.join('\n')}`;

    const constraints = [];
    if (/scorm 1\.2|scorm1\.2/i.test(textBlob)) constraints.push('Target LMS format: SCORM 1.2');
    if (/scorm 2004|scorm2004/i.test(textBlob)) constraints.push('Target LMS format: SCORM 2004');
    if (/cmi5/i.test(textBlob)) constraints.push('Target LMS format: cmi5');
    if (/lti/i.test(textBlob)) constraints.push('Target LMS format: LTI');
    if (/wcag|accessib|screen reader|alt text|keyboard/i.test(textBlob)) constraints.push('Accessibility requirements are important');
    if (/compliance|policy|regulat|safety|hipaa|sox|gdpr/i.test(textBlob)) constraints.push('Compliance accuracy is required');
    if (/brand|style guide|voice|tone/i.test(textBlob)) constraints.push('Keep language aligned with brand/style guidance');

    const goals = [];
    for (const msg of recentUser.slice(-8)) {
        const clean = msg.replace(/\s+/g, ' ').trim();
        if (!clean) continue;
        if (clean.length < 24) continue;
        goals.push(clean.slice(0, 160));
    }

    const decisions = [];
    for (const msg of recentAssistant.slice(-6)) {
        const lines = msg.split('\n').map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
            if (/^[-*]\s|^\d+\./.test(line) || /updated|changed|added|revised|implemented|created/i.test(line)) {
                decisions.push(line.replace(/^[-*]\s*/, '').slice(0, 160));
            }
        }
    }

    const openQuestions = [];
    for (const msg of recentAssistant.slice(-6)) {
        const questions = msg.split('\n').filter(l => l.includes('?')).slice(0, 3);
        for (const q of questions) openQuestions.push(q.trim().slice(0, 160));
    }

    const audienceMatch = allBlob.match(/(audience|learners?|employees?|students?)[:\s-]{1,6}([^\n.]{4,80})/i);
    const durationMatch = allBlob.match(/(\d+\s?(minute|min|hour|hr|day|week)s?)/i);

    const summaryParts = [];
    if (audienceMatch?.[2]) summaryParts.push(`Audience: ${audienceMatch[2].trim()}`);
    if (durationMatch?.[1]) summaryParts.push(`Target duration: ${durationMatch[1].trim()}`);
    if (goals.length) summaryParts.push(`Current goals: ${uniqueList(goals).slice(0, 3).join(' | ')}`);
    if (!summaryParts.length) summaryParts.push('Maintain course coherence across slides, interactions, and assessments.');

    return {
        updatedAt: new Date().toISOString(),
        summary: summaryParts.join(' '),
        constraints: uniqueList([...(existing?.constraints || []), ...constraints]).slice(-10),
        decisions: uniqueList([...(existing?.decisions || []), ...decisions]).slice(-12),
        openQuestions: uniqueList(openQuestions).slice(-8),
        recentGoals: uniqueList(goals).slice(-8)
    };
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

function mergeToolDefinitions(staticTools = [], discoveredTools = []) {
    const merged = [];
    const byName = new Map();

    for (const tool of staticTools) {
        if (!tool?.name) continue;
        byName.set(tool.name, tool);
        merged.push(tool);
    }

    for (const tool of discoveredTools) {
        const name = tool?.name;
        if (!name) continue;

        const normalized = {
            name,
            description: tool.description || byName.get(name)?.description || `CourseCode tool: ${name}`,
            input_schema: tool.inputSchema || tool.input_schema || byName.get(name)?.input_schema || { type: 'object', properties: {} }
        };

        if (byName.has(name)) {
            const idx = merged.findIndex(t => t.name === name);
            if (idx >= 0) merged[idx] = { ...merged[idx], ...normalized };
            byName.set(name, merged[idx]);
        } else {
            byName.set(name, normalized);
            merged.push(normalized);
        }
    }

    return merged;
}

function sanitizeToolResultForModel(toolName, result) {
    if (toolName === 'coursecode_screenshot' && result?.content && Array.isArray(result.content)) {
        const textBlocks = result.content
            .filter(block => block?.type === 'text' && typeof block.text === 'string')
            .map(block => block.text.trim())
            .filter(Boolean);
        const imageCount = result.content.filter(block => block?.type === 'image').length;

        const summary = [
            textBlocks.join('\n').trim(),
            imageCount > 0
                ? `[${imageCount} screenshot image block(s) omitted from model context; screenshot already sent to the UI]`
                : ''
        ].filter(Boolean).join('\n\n');

        return truncateContent(summary || '[Screenshot captured]');
    }

    const safeJson = JSON.stringify(result, (key, value) => {
        if ((key === 'data' || key === 'base64') && typeof value === 'string' && value.length > 160) {
            return `[omitted binary data: ${value.length} chars]`;
        }
        return value;
    });

    return truncateContent(safeJson);
}

// --- Tool execution ---

async function executeTool(toolName, toolInput, projectPath, webContents) {
    const resolveToolPath = (candidatePath) => {
        if (typeof candidatePath !== 'string' || !candidatePath.trim()) {
            throw new Error('Tool path must be a non-empty string');
        }
        const root = resolve(projectPath);
        const target = resolve(root, candidatePath);
        if (target !== root && !target.startsWith(`${root}\\`) && !target.startsWith(`${root}/`)) {
            throw new Error(`Path escapes project root: ${candidatePath}`);
        }
        return target;
    };

    // File operations
    if (toolName === 'read_file') {
        const filePath = resolveToolPath(toolInput.path);
        if (!existsSync(filePath)) return { error: `File not found: ${toolInput.path}` };
        return { content: readFileSync(filePath, 'utf-8') };
    }

    if (toolName === 'edit_file') {
        const filePath = resolveToolPath(toolInput.path);
        if (!existsSync(filePath)) return { error: `File not found: ${toolInput.path}` };
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

    if (toolName === 'list_files') {
        const dirPath = resolveToolPath(toolInput.path || '.');
        if (!existsSync(dirPath)) return { error: `Directory not found: ${toolInput.path}` };
        const entries = readdirSync(dirPath, { withFileTypes: true });
        return {
            files: entries.map(e => ({
                name: e.name,
                type: e.isDirectory() ? 'directory' : 'file'
            }))
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
    let modelId = isCloud ? (getSetting('cloudAiModel') || DEFAULT_CLOUD_MODEL) : (getSetting('aiModel') || DEFAULT_MODEL);

    log.info(`sendMessage → ${providerId}/${modelId}`, { mode, hasMentions: mentions?.length > 0 });

    let credential;
    let cloudProvider = null;
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
                log.debug('Resolved cloud provider', { modelId, cloudProvider });
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
            modelId = providerModels.find(m => m.default)?.id || providerModels[0]?.id || FALLBACK_MODELS[providerId] || DEFAULT_MODEL;
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

    // Resolve mentions and append user message
    const resolvedMessage = resolveMentions(projectPath, userMessage, mentions);
    messages.push({ role: 'user', content: resolvedMessage, _display: userMessage, _mentions: mentions });
    persistConversation(projectPath, messages, sessionContext);

    // Set up abort controller
    const controller = new AbortController();
    abortControllers.set(projectPath, controller);

    // Build system prompt with project context + memory
    const projectContext = getProjectContext(projectPath);
    const storedMemory = loadProjectMemory(projectPath);
    const executionPlan = deriveExecutionPlan(userMessage, projectContext);
    const systemPrompt = buildSystemPrompt(projectContext, storedMemory);

    webContents?.send('chat:plan', {
        projectPath,
        status: 'started',
        steps: executionPlan
    });

    // Build API messages with truncation for efficiency
    // For cloud models, translate to the upstream provider's wire format
    let apiMessages;
    if (cloudProvider === 'openai') {
        apiMessages = prepareOpenAIMessages(messages);
    } else if (cloudProvider === 'google') {
        apiMessages = prepareGoogleMessages(messages);
    } else {
        apiMessages = prepareApiMessages(messages);
    }

    try {
        const provider = await createProvider(providerId, credential, { cloudProvider });
        let runtimeTools = getToolDefinitions();
        if (getPreviewStatus(projectPath) === 'running') {
            const discoveredTools = await getMcpTools(projectPath);
            runtimeTools = mergeToolDefinitions(runtimeTools, discoveredTools);
        }
        log.debug('Provider created, starting agentic loop');
        let sessionInputTokens = 0;
        let sessionOutputTokens = 0;
        let sessionCreditsCharged = 0;
        let sessionCacheCreation = 0;
        let sessionCacheRead = 0;

        // Agentic loop: keep calling LLM until it stops requesting tools
        let continueLoop = true;
        let hadToolErrors = false;
        let planSteps = executionPlan.map(s => ({ ...s }));
        const markPlanStep = (stepId, status, note) => {
            planSteps = planSteps.map(s => s.id === stepId ? { ...s, status } : s);
            webContents?.send('chat:plan', {
                projectPath,
                status: 'step',
                steps: planSteps,
                stepId,
                stepStatus: status,
                note
            });
        };

        // Auto-snapshot before AI starts making changes
        const chatIndex = messages.length - 1; // Index of the user message
        try { await createSnapshot(projectPath, 'Before AI changes', { chatIndex }); } catch (err) { log.debug('Pre-AI snapshot failed (repo may not be initialized)', err); }

        markPlanStep('inspect', 'in_progress', 'Reviewing current course state');

        while (continueLoop) {
            continueLoop = false;

            log.debug('Calling LLM', { messageCount: apiMessages.length, model: modelId });
            const stream = provider.chat({
                messages: apiMessages,
                tools: runtimeTools,
                system: systemPrompt,
                model: modelId,
                signal: controller.signal
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
                } else if (event.type === 'tool_use_start') {
                    currentToolId = event.id;
                    currentToolName = event.name;
                    toolInputJson = '';
                    toolStartById.set(event.id, Date.now());
                    webContents?.send('chat:toolUse', {
                        projectPath,
                        tool: event.name,
                        toolUseId: event.id,
                        label: TOOL_LABELS[event.name] || `Using ${event.name}…`,
                        status: 'running',
                        startedAt: Date.now(),
                        reason: toolReason(event.name)
                    });
                } else if (event.type === 'tool_use_delta') {
                    toolInputJson += event.json;
                } else if (event.type === 'content_block_stop') {
                    if (currentToolId && currentToolName) {
                        let toolInput = {};
                        try { toolInput = JSON.parse(toolInputJson); } catch (err) { log.debug('Failed to parse tool input JSON (may be partial)', err); }
                        currentToolCalls.push({
                            id: currentToolId,
                            name: currentToolName,
                            input: toolInput,
                            startedAt: toolStartById.get(currentToolId) || Date.now()
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

                    // Cloud stream timeout — the upstream provider stopped responding
                    if (event.timedOut && !currentText && currentToolCalls.length === 0) {
                        log.warn('Cloud stream timed out with no content');
                        throw new Error('The AI service timed out before producing a response. Try again.');
                    }

                    // Store assistant message
                    const assistantContent = [];
                    if (currentText) {
                        assistantContent.push({ type: 'text', text: currentText });
                    }
                    for (const tc of currentToolCalls) {
                        assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
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
                        if (cloudProvider === 'openai') {
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
                                if (block.type === 'tool_use') parts.push({ functionCall: { name: block.name, args: block.input || {} } });
                            }
                            if (parts.length > 0) apiMessages.push({ role: 'model', parts });
                        } else {
                            apiMessages.push({ role: 'assistant', content: assistantContent });
                        }
                    }
                    persistConversation(projectPath, messages, sessionContext);

                    // Execute tool calls sequentially to preserve deterministic ordering.
                    if (currentToolCalls.length > 0) {
                        markPlanStep('inspect', 'completed', 'Context gathered');
                        markPlanStep('author', 'in_progress', 'Applying requested course updates');
                        const toolResults = [];
                        for (const tc of currentToolCalls) {
                            log.debug(`Executing tool: ${tc.name}`);
                            try {
                                const result = await executeTool(tc.name, tc.input, projectPath, webContents);
                                const finishedAt = Date.now();
                                const elapsedMs = Math.max(0, finishedAt - (tc.startedAt || finishedAt));

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
                                    status: 'done',
                                    finishedAt,
                                    elapsedMs,
                                    reason: toolReason(tc.name),
                                    filePath: tc.input?.path || undefined,
                                    detail: tc.input?.path || tc.input?.slideId || undefined
                                });

                                toolResults.push({
                                    meta: {
                                        id: tc.id,
                                        name: tc.name,
                                        status: 'done',
                                        elapsedMs,
                                        filePath: tc.input?.path || undefined,
                                        detail: tc.input?.path || tc.input?.slideId || undefined,
                                        reason: toolReason(tc.name)
                                    },
                                    type: 'tool_result',
                                    tool_use_id: tc.id,
                                    content: sanitizeToolResultForModel(tc.name, result)
                                });
                            } catch (err) {
                                log.warn(`Tool execution failed: ${tc.name}`, err);
                                hadToolErrors = true;
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
                            if (cloudProvider === 'openai') {
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
                                    try { responseData = JSON.parse(raw); } catch { responseData = { result: raw }; }
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
                        currentText = '';
                        currentToolCalls = [];
                    }
                    // Done is terminal for this stream — break to prevent duplicate processing
                    break;
                }

                if (controller.signal.aborted) break;
            }

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

            if (totalChanged > 0) {
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
            }
        } catch (err) { log.debug('Post-AI snapshot failed', err); }

        markPlanStep('author', hadToolErrors ? 'error' : 'completed', hadToolErrors ? 'Some tool actions failed' : 'Requested updates applied');
        markPlanStep('verify', hadToolErrors ? 'error' : 'completed', hadToolErrors ? 'Review suggested due to tool errors' : 'Validation complete');
        markPlanStep('summarize', 'completed', 'Response finalized');

        // Done
        const cost = isCloud ? null : estimateCost(
            getSetting('aiProvider') || DEFAULT_PROVIDER,
            modelId,
            sessionInputTokens,
            sessionOutputTokens
        );

        webContents?.send('chat:done', {
            projectPath,
            message: messages.filter(m => m.role === 'assistant' && m.content).pop()?.content || '',
            usage: {
                inputTokens: sessionInputTokens,
                outputTokens: sessionOutputTokens,
                totalTokens: sessionInputTokens + sessionOutputTokens,
                estimatedCost: cost,
                creditsCharged: isCloud ? sessionCreditsCharged : undefined
            }
        });

        const updatedMemory = extractCourseMemory(messages, storedMemory);
        saveProjectMemory(projectPath, updatedMemory);
        webContents?.send('chat:memoryUpdated', {
            projectPath,
            memory: updatedMemory
        });
        webContents?.send('chat:plan', {
            projectPath,
            status: hadToolErrors ? 'completed_with_errors' : 'completed',
            steps: planSteps
        });

    } catch (err) {
        if (err.name === 'AbortError') {
            webContents?.send('chat:plan', { projectPath, status: 'cancelled' });
            return;
        }

        log.error('Chat flow failed', err);
        persistConversation(projectPath, messages);
        const userMessage = translateChatError(err, isCloud);
        webContents?.send('chat:error', { projectPath, message: userMessage });
    } finally {
        abortControllers.delete(projectPath);
    }
}

export function summarizeContext(projectPath) {
    const messages = conversations.get(projectPath) || loadConversation(projectPath);
    const existing = loadProjectMemory(projectPath);
    const memory = extractCourseMemory(messages, existing);
    saveProjectMemory(projectPath, memory);
    conversations.set(projectPath, messages);
    return memory;
}

export function getContextMemory(projectPath) {
    return loadProjectMemory(projectPath);
}

export function stopGeneration(projectPath) {
    const controller = abortControllers.get(projectPath);
    if (controller) {
        controller.abort();
        abortControllers.delete(projectPath);
    }
}

export function clearConversation(projectPath) {
    conversations.delete(projectPath);
    conversationSessions.delete(projectPath);
    migrateLegacyChatStorage(projectPath);
    const convPath = getConversationPath(projectPath);
    if (existsSync(convPath)) {
        unlinkSync(convPath);
    }
    const memoryPath = getMemoryPath(projectPath);
    if (existsSync(memoryPath)) {
        unlinkSync(memoryPath);
    }
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
