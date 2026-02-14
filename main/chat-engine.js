import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { createProvider, loadApiKey, estimateCost } from './llm-provider.js';
import { loadToken } from './cloud-client.js';
import { buildSystemPrompt, getToolDefinitions } from './system-prompts.js';
import { getSetting } from './settings.js';
import { startPreview, getPreviewStatus } from './preview-manager.js';
import { getMcpClient } from './mcp-client.js';
import { listRefs, readRef } from './ref-manager.js';
import { createSnapshot, getChanges } from './snapshot-manager.js';
import { createLogger } from './logger.js';
import { translateChatError } from './errors.js';
import {
    TOOL_LABELS, PREVIEW_TOOLS, DEFAULT_PROVIDER, DEFAULT_MODEL, DEFAULT_CLOUD_MODEL,
    TOOL_RESULT_MAX_CHARS, TOOL_RESULT_TRUNCATION_NOTE
} from './ai-config.js';

const log = createLogger('chat');

// --- Active conversations by projectPath ---
const conversations = new Map();

// --- Active abort controllers ---
const abortControllers = new Map();

// --- Build API messages with truncation ---

function truncateContent(content) {
    if (typeof content !== 'string') content = JSON.stringify(content);
    if (content.length <= TOOL_RESULT_MAX_CHARS) return content;
    return content.slice(0, TOOL_RESULT_MAX_CHARS) + TOOL_RESULT_TRUNCATION_NOTE;
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

    for (let i = 0; i <= lastIndex; i++) {
        const m = messages[i];
        const isRecent = i >= lastIndex - 3; // keep the last few messages untruncated

        if (m.role === 'user') {
            // Skip empty user messages (Anthropic rejects them)
            const isEmpty = !m.content || (Array.isArray(m.content) && m.content.length === 0);
            if (isEmpty) continue;
            apiMessages.push({ role: 'user', content: m.content });
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
                }
                apiMessages.push(raw);
            } else if (m.content) {
                apiMessages.push({ role: 'assistant', content: m.content });
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

// --- Conversation persistence ---

function getChatDir(projectPath) {
    return join(projectPath, '.chat');
}

function getConversationPath(projectPath) {
    return join(getChatDir(projectPath), 'conversation.json');
}

function getMemoryPath(projectPath) {
    return join(getChatDir(projectPath), 'context-memory.json');
}

function loadConversation(projectPath) {
    const convPath = getConversationPath(projectPath);
    if (!existsSync(convPath)) return [];
    try {
        const data = JSON.parse(readFileSync(convPath, 'utf-8'));
        return data.messages || [];
    } catch (err) {
        log.warn('Failed to load conversation', err);
        return [];
    }
}

function saveConversation(projectPath, messages) {
    const chatDir = getChatDir(projectPath);
    if (!existsSync(chatDir)) mkdirSync(chatDir, { recursive: true });
    writeFileSync(
        getConversationPath(projectPath),
        JSON.stringify({ messages, savedAt: new Date().toISOString() }, null, 2)
    );
}

function loadProjectMemory(projectPath) {
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
        case 'write_file':
            return 'Apply requested instructional content changes';
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
    for (const mention of mentions) {
        try {
            if (mention.type === 'slide') {
                const slidePath = join(projectPath, 'course', 'slides', `${mention.id}.js`);
                if (existsSync(slidePath)) {
                    const content = readFileSync(slidePath, 'utf-8');
                    contextParts.push(`[Referenced slide: "${mention.title}"]\n${content}`);
                }
            } else if (mention.type === 'ref') {
                const { content } = readRef(projectPath, mention.filename);
                contextParts.push(`[Referenced document: "${mention.filename}"]\n${content}`);
            } else if (mention.type === 'interaction') {
                const assessmentFiles = readdirSync(join(projectPath, 'course', 'assessments')).filter(f => f.endsWith('.js'));
                for (const file of assessmentFiles) {
                    const content = readFileSync(join(projectPath, 'course', 'assessments', file), 'utf-8');
                    if (content.includes(mention.id)) {
                        contextParts.push(`[Referenced interaction: "${mention.id}"]\n${content}`);
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

// --- Tool execution ---

async function executeTool(toolName, toolInput, projectPath, webContents) {
    // File operations
    if (toolName === 'read_file') {
        const filePath = join(projectPath, toolInput.path);
        if (!existsSync(filePath)) return { error: `File not found: ${toolInput.path}` };
        return { content: readFileSync(filePath, 'utf-8') };
    }

    if (toolName === 'write_file') {
        const filePath = join(projectPath, toolInput.path);
        const dir = join(filePath, '..');
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(filePath, toolInput.content);
        return { success: true, path: toolInput.path };
    }

    if (toolName === 'list_files') {
        const dirPath = join(projectPath, toolInput.path || '.');
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
    const modelId = isCloud ? (getSetting('cloudAiModel') || DEFAULT_CLOUD_MODEL) : (getSetting('aiModel') || DEFAULT_MODEL);

    log.info(`sendMessage → ${providerId}/${modelId}`, { mode, hasMentions: mentions?.length > 0 });

    let credential;
    if (isCloud) {
        credential = loadToken();
        if (!credential) {
            webContents?.send('chat:error', {
                projectPath,
                message: 'Not signed in to CourseCode Cloud. Sign in from Settings or the Dashboard.'
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
    }

    // Load or init conversation
    let messages = conversations.get(projectPath) || loadConversation(projectPath);

    // Resolve mentions and append user message
    const resolvedMessage = resolveMentions(projectPath, userMessage, mentions);
    messages.push({ role: 'user', content: resolvedMessage, _display: userMessage, _mentions: mentions });
    conversations.set(projectPath, messages);

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
    const apiMessages = prepareApiMessages(messages);

    try {
        const provider = await createProvider(providerId, credential);
        log.debug('Provider created, starting agentic loop');
        let sessionInputTokens = 0;
        let sessionOutputTokens = 0;
        let sessionCreditsCharged = 0;
        let sessionCacheCreation = 0;
        let sessionCacheRead = 0;

        // Agentic loop: keep calling LLM until it stops requesting tools
        let continueLoop = true;
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
                tools: getToolDefinitions(),
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
                        apiMessages.push({ role: 'assistant', content: assistantContent });
                    }

                    // Execute tool calls in parallel
                    if (currentToolCalls.length > 0) {
                        markPlanStep('inspect', 'completed', 'Context gathered');
                        markPlanStep('author', 'in_progress', 'Applying requested course updates');
                        const toolResults = await Promise.all(currentToolCalls.map(async (tc) => {
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

                                return {
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
                                    content: typeof result === 'string' ? result : JSON.stringify(result)
                                };
                            } catch (err) {
                                log.warn(`Tool execution failed: ${tc.name}`, err);
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

                                return {
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
                                };
                            }
                        }));

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
                            apiMessages.push({ role: 'user', content: toolResultContents });
                        }

                        // Backfill tool metadata on the assistant message that triggered these tool calls
                        const lastAssistant = messages.slice().reverse().find(m => m.role === 'assistant' && m._toolCalls?.length);
                        if (lastAssistant) {
                            lastAssistant._toolCalls = lastAssistant._toolCalls.map(tc => {
                                const meta = toolMetaById.get(tc.id || tc.toolUseId);
                                return meta ? { ...tc, ...meta } : tc;
                            });
                        }

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
        conversations.set(projectPath, messages);
        saveConversation(projectPath, messages.map(m => ({
            role: m.role,
            content: m.content,
            _display: m._display,
            _mentions: m._mentions,
            _toolCalls: m._toolCalls,
            _usage: m._usage,
            _raw: m._raw,
            tool_use_id: m.tool_use_id,
            is_error: m.is_error
        })));

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
                    added: changes.added,
                    modified: changes.modified,
                    deleted: changes.deleted,
                    snapshotId: snap.id
                });
            }
        } catch (err) { log.debug('Post-AI snapshot failed', err); }

        markPlanStep('author', 'completed', 'Requested updates applied');
        markPlanStep('verify', 'completed', 'Validation complete');
        markPlanStep('summarize', 'completed', 'Response finalized');

        // Done
        const cost = isCloud ? null : estimateCost(
            getSetting('aiProvider') || DEFAULT_PROVIDER,
            getSetting('aiModel') || DEFAULT_MODEL,
            sessionInputTokens,
            sessionOutputTokens
        );

        webContents?.send('chat:done', {
            projectPath,
            usage: {
                inputTokens: sessionInputTokens,
                outputTokens: sessionOutputTokens,
                totalTokens: sessionInputTokens + sessionOutputTokens,
                estimatedCost: cost,
                creditsCharged: sessionCreditsCharged || undefined
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
            status: 'completed',
            steps: planSteps.map(s => ({ ...s, status: 'completed' }))
        });

    } catch (err) {
        if (err.name === 'AbortError') {
            webContents?.send('chat:plan', { projectPath, status: 'cancelled' });
            return;
        }

        log.error('Chat flow failed', err);
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
    const convPath = getConversationPath(projectPath);
    if (existsSync(convPath)) {
        const { unlinkSync } = require('fs');
        unlinkSync(convPath);
    }
    const memoryPath = getMemoryPath(projectPath);
    if (existsSync(memoryPath)) {
        const { unlinkSync } = require('fs');
        unlinkSync(memoryPath);
    }
}

export function loadHistory(projectPath) {
    const messages = loadConversation(projectPath);
    conversations.set(projectPath, messages);
    return messages.map(m => ({
        role: m.role,
        content: m._display || m.content,
        toolCalls: m._toolCalls,
        usage: m._usage,
        mentions: m._mentions
    })).filter(m => m.role === 'user' || m.role === 'assistant');
}
