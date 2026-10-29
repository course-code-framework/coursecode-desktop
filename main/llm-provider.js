import { app, net, safeStorage } from 'electron';
import { join } from 'path';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { MAX_TOKENS } from './ai-config.js';
import { createLogger } from './logger.js';

const log = createLogger('ai');

// --- Provider Registry ---

const providers = {
    anthropic: {
        name: 'Anthropic',
        models: [],
        keyPlaceholder: 'sk-ant-...',
        keyPattern: /^sk-ant-/,
        docs: 'https://console.anthropic.com/settings/keys',
        pricing: {
            'claude-sonnet-4-20250514': { input: 3, output: 15 }
        }
    },
    openai: {
        name: 'OpenAI',
        models: [],
        keyPlaceholder: 'sk-...',
        keyPattern: /^sk-/,
        docs: 'https://platform.openai.com/api-keys',
        pricing: {
            'gpt-4o': { input: 2.5, output: 10 },
            'o3': { input: 10, output: 40 }
        }
    }
};

const googleProviderInfo = {
    google: {
        name: 'Google',
        models: [],
        keyPlaceholder: 'AIza...',
        keyPattern: /^AIza/,
        docs: 'https://aistudio.google.com/apikey',
        pricing: {
            'gemini-2.5-pro': { input: 1.25, output: 10 },
            'gemini-2.5-flash': { input: 0.15, output: 0.6 }
        }
    }
};

Object.assign(providers, googleProviderInfo);

/**
 * Dynamic model limits — populated by fetching from provider APIs.
 * No hardcoded per-model maps needed.
 */
const modelOutputLimits = new Map();
const modelContextWindows = new Map();

export function getModelOutputLimit(modelId) {
    return modelOutputLimits.get(modelId) || null;
}

export function getModelContextWindow(modelId) {
    return modelContextWindows.get(modelId) || null;
}

/**
 * Get the max output tokens for a model.
 * Uses dynamically fetched limits from provider APIs, falling back to MAX_TOKENS.
 */
function getMaxOutputTokens(modelId) {
    return modelOutputLimits.get(modelId) || MAX_TOKENS;
}

// --- API Key Storage (encrypted via safeStorage) ---

function getKeysDir() {
    const dir = join(app.getPath('userData'), 'ai-keys');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
}

export function saveApiKey(provider, apiKey) {
    if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('System encryption is not available. Cannot securely store API key.');
    }
    const keyPath = join(getKeysDir(), `${provider}.key`);
    const encrypted = safeStorage.encryptString(apiKey);
    writeFileSync(keyPath, encrypted);
}

export function loadApiKey(provider) {
    if (!safeStorage.isEncryptionAvailable()) return null;

    const keyPath = join(getKeysDir(), `${provider}.key`);
    if (!existsSync(keyPath)) return null;

    try {
        const data = readFileSync(keyPath);
        return safeStorage.decryptString(data);
    } catch (error) {
        log.warn(`Failed to decrypt key for ${provider}`, error);
        return null;
    }
}

export function removeApiKey(provider) {
    const keyPath = join(getKeysDir(), `${provider}.key`);
    if (existsSync(keyPath)) unlinkSync(keyPath);
}

export function hasApiKey(provider) {
    const keyPath = join(getKeysDir(), `${provider}.key`);
    return existsSync(keyPath);
}

// --- Provider Info ---

function labelFromModelId(modelId) {
    return modelId
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
}

function markDefaultModel(models, preferredIds = []) {
    if (!Array.isArray(models) || models.length === 0) return [];
    const preferredId = preferredIds.find(id => models.some(m => m.id === id));
    const firstId = preferredId || models[0].id;
    return models.map(m => ({ ...m, default: m.id === firstId }));
}

async function fetchAnthropicModels(apiKey) {
    const response = await net.fetch('https://api.anthropic.com/v1/models', {
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
        }
    });

    if (!response.ok) {
        throw Object.assign(new Error(`Anthropic model fetch failed: HTTP ${response.status}`), { status: response.status });
    }

    const payload = await response.json();
    const discovered = (payload.data || [])
        .filter(m => typeof m?.id === 'string' && m.id.startsWith('claude-'))
        .map(m => {
            // Anthropic returns max_tokens (max output) and max_input_tokens per model
            if (m.max_tokens) modelOutputLimits.set(m.id, m.max_tokens);
            if (m.max_input_tokens) modelContextWindows.set(m.id, m.max_input_tokens);
            return { id: m.id, label: labelFromModelId(m.id) };
        });

    return markDefaultModel(discovered, [
        'claude-sonnet-4-20250514',
        'claude-4-sonnet'
    ]);
}

async function fetchOpenAIModels(apiKey) {
    const response = await net.fetch('https://api.openai.com/v1/models', {
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'content-type': 'application/json'
        }
    });

    if (!response.ok) {
        throw Object.assign(new Error(`OpenAI model fetch failed: HTTP ${response.status}`), { status: response.status });
    }

    const payload = await response.json();
    const discovered = (payload.data || [])
        .map(m => m?.id)
        .filter(id => typeof id === 'string' && (/^gpt-/.test(id) || /^o\d/.test(id)))
        .map(id => {
            // OpenAI's /v1/models doesn't return output/context limits,
            // so populate known values for accurate max_tokens requests.
            const limits = OPENAI_KNOWN_LIMITS[id];
            if (limits?.output) modelOutputLimits.set(id, limits.output);
            if (limits?.context) modelContextWindows.set(id, limits.context);
            return { id, label: labelFromModelId(id) };
        });

    return markDefaultModel(discovered, ['gpt-4o', 'o3']);
}

/**
 * OpenAI's /v1/models endpoint doesn't include output or context limits.
 * These are populated from documented model capabilities to avoid falling
 * back to the generic MAX_TOKENS (8192) default.
 */
const OPENAI_KNOWN_LIMITS = {
    'gpt-4o': { output: 16384, context: 128000 },
    'gpt-4o-mini': { output: 16384, context: 128000 },
    'o3': { output: 100000, context: 200000 },
    'o3-mini': { output: 65536, context: 200000 },
    'o4-mini': { output: 100000, context: 200000 },
};

async function fetchGoogleModels(apiKey) {
    const response = await net.fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);

    if (!response.ok) {
        throw Object.assign(new Error(`Google model fetch failed: HTTP ${response.status}`), { status: response.status });
    }

    const payload = await response.json();
    const discovered = (payload.models || [])
        .filter(m => typeof m?.name === 'string' && m.name.includes('gemini-'))
        .map(m => {
            const id = m.name.replace('models/', '');
            // Google returns outputTokenLimit and inputTokenLimit per model
            if (m.outputTokenLimit) modelOutputLimits.set(id, m.outputTokenLimit);
            if (m.inputTokenLimit) modelContextWindows.set(id, m.inputTokenLimit);
            return { id, label: labelFromModelId(id) };
        });

    return markDefaultModel(discovered, ['gemini-2.5-pro', 'gemini-2.5-flash']);
}

export async function getProviders({ includeModels = false } = {}) {
    const entries = await Promise.all(Object.entries(providers).map(async ([id, p]) => {
        const hasKey = hasApiKey(id);
        let models = [];
        let modelFetchFailed = false;
        let modelFetchError = null;
        const key = includeModels ? loadApiKey(id) : null;

        if (key) {
            try {
                if (id === 'anthropic') {
                    const discovered = await fetchAnthropicModels(key);
                    if (discovered.length > 0) {
                        models = discovered;
                    } else {
                        modelFetchFailed = true;
                        modelFetchError = `No models were returned by ${p.name}.`;
                    }
                } else if (id === 'openai') {
                    const discovered = await fetchOpenAIModels(key);
                    if (discovered.length > 0) {
                        models = discovered;
                    } else {
                        modelFetchFailed = true;
                        modelFetchError = `No models were returned by ${p.name}.`;
                    }
                } else if (id === 'google') {
                    const discovered = await fetchGoogleModels(key);
                    if (discovered.length > 0) {
                        models = discovered;
                    } else {
                        modelFetchFailed = true;
                        modelFetchError = `No models were returned by ${p.name}.`;
                    }
                }
            } catch (err) {
                modelFetchFailed = true;
                modelFetchError = err?.message || `Failed to fetch models from ${p.name}.`;
                log.warn(`Failed to refresh ${id} models`, err);
            }
        }

        providers[id].models = models;

        return {
            id,
            name: p.name,
            models: models.map(m => {
            const pricing = p.pricing?.[m.id];
            return { ...m, costScore: pricing ? pricing.input + pricing.output : null };
        }),
        keyPlaceholder: p.keyPlaceholder,
        docs: p.docs,
        hasKey,
        modelFetchFailed,
        modelFetchError
        };
    }));

    return entries;
}

export function getProviderModels(providerId) {
    return providers[providerId]?.models || [];
}

// --- Estimate cost ---

export function estimateCost(providerId, modelId, inputTokens, outputTokens) {
    const pricing = providers[providerId]?.pricing?.[modelId];
    if (!pricing) return null;
    return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

// --- Provider Factory ---

async function createAnthropicProvider(apiKey) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });

    return {
        async *chat({ messages, tools, system, model, signal }) {
            // Apply cache_control to tools and early conversation messages
            // for maximum prompt caching benefit.
            // Anthropic caches from the top of the request down to the last
            // cache_control marker, so we mark: system, tools (last tool),
            // and the boundary message right before the recent turns.
            const cachedTools = tools?.length ? tools.map((t, i) => {
                if (i === tools.length - 1) {
                    // Mark the last tool with cache_control so the entire tool
                    // definitions block is cached across turns
                    return { ...t, cache_control: { type: 'ephemeral' } };
                }
                return t;
            }) : [];

            // Mark the conversation history cache boundary.
            // We cache everything up to (but not including) the last 2 messages,
            // which change every turn. This means the system prompt + tools +
            // all older conversation history is cached.
            const cachedMessages = messages.map((m, i) => {
                // Mark the message just before the last 2 messages as a cache point
                if (i === messages.length - 3 && i >= 0 && m.role === 'user') {
                    if (typeof m.content === 'string') {
                        return {
                            ...m,
                            content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }]
                        };
                    }
                    if (Array.isArray(m.content) && m.content.length > 0) {
                        const lastIdx = m.content.length - 1;
                        return {
                            ...m,
                            content: m.content.map((block, bi) =>
                                bi === lastIdx ? { ...block, cache_control: { type: 'ephemeral' } } : block
                            )
                        };
                    }
                }
                return m;
            });

            const stream = client.messages.stream({
                model,
                max_tokens: getMaxOutputTokens(model),
                system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
                messages: cachedMessages,
                tools: cachedTools,
            }, { signal });

            for await (const event of stream) {
                if (event.type === 'content_block_start') {
                    if (event.content_block.type === 'tool_use') {
                        yield { type: 'tool_use_start', id: event.content_block.id, name: event.content_block.name };
                    }
                } else if (event.type === 'content_block_delta') {
                    if (event.delta.type === 'text_delta') {
                        yield { type: 'text', text: event.delta.text };
                    } else if (event.delta.type === 'input_json_delta') {
                        yield { type: 'tool_use_delta', json: event.delta.partial_json };
                    }
                } else if (event.type === 'content_block_stop') {
                    yield { type: 'content_block_stop', index: event.index };
                } else if (event.type === 'message_stop') {
                    const msg = stream.currentMessage;
                    yield {
                        type: 'done',
                        stopReason: msg?.stop_reason,
                        usage: {
                            inputTokens: msg?.usage?.input_tokens || 0,
                            outputTokens: msg?.usage?.output_tokens || 0,
                            cacheCreationInputTokens: msg?.usage?.cache_creation_input_tokens || 0,
                            cacheReadInputTokens: msg?.usage?.cache_read_input_tokens || 0
                        },
                        message: msg
                    };
                }
            }
        },

        async validateKey() {
            try {
                await net.fetch('https://api.anthropic.com/v1/models', {
                    headers: {
                        'x-api-key': apiKey,
                        'anthropic-version': '2023-06-01',
                        'content-type': 'application/json'
                    }
                }).then(r => { if (!r.ok) throw { status: r.status }; });
                return { valid: true };
            } catch (err) {
                if (err.status === 401) return { valid: false, error: 'Invalid API key' };
                // Other errors (rate limit etc.) mean the key is valid
                return { valid: true };
            }
        }
    };
}

async function createOpenAIProvider(apiKey) {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey });

    function toToolCallIndex(rawIndex, fallback = 0) {
        if (Number.isInteger(rawIndex)) return rawIndex;
        const parsed = Number(rawIndex);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function toOpenAIMessages(messages, system) {
        const converted = [{ role: 'system', content: system }];

        for (const msg of messages || []) {
            if (!msg || typeof msg !== 'object') continue;

            if (msg.role === 'user') {
                if (typeof msg.content === 'string') {
                    converted.push({ role: 'user', content: msg.content });
                    continue;
                }

                if (Array.isArray(msg.content)) {
                    const textParts = [];
                    const toolResults = [];

                    for (const block of msg.content) {
                        if (!block || typeof block !== 'object') continue;

                        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
                            textParts.push(block.text);
                        }

                        if (block.type === 'tool_result' && block.tool_use_id) {
                            const resultContent = typeof block.content === 'string'
                                ? block.content
                                : JSON.stringify(block.content || {});
                            toolResults.push({
                                role: 'tool',
                                tool_call_id: block.tool_use_id,
                                content: resultContent
                            });
                        }
                    }

                    // Emit tool results first so they stay adjacent to the
                    // preceding assistant message with tool_calls (OpenAI
                    // requires this ordering). Text follows after.
                    converted.push(...toolResults);
                    if (textParts.length > 0) {
                        converted.push({ role: 'user', content: textParts.join('\n\n') });
                    }
                }
                continue;
            }

            if (msg.role === 'assistant') {
                if (typeof msg.content === 'string') {
                    converted.push({ role: 'assistant', content: msg.content });
                    continue;
                }

                if (Array.isArray(msg.content)) {
                    const textParts = [];
                    const toolCalls = [];

                    for (const block of msg.content) {
                        if (!block || typeof block !== 'object') continue;

                        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
                            textParts.push(block.text);
                        }

                        if (block.type === 'tool_use' && block.id && block.name) {
                            toolCalls.push({
                                id: block.id,
                                type: 'function',
                                function: {
                                    name: block.name,
                                    arguments: JSON.stringify(block.input || {})
                                }
                            });
                        }
                    }

                    if (toolCalls.length > 0) {
                        converted.push({
                            role: 'assistant',
                            content: textParts.length > 0 ? textParts.join('\n\n') : '',
                            tool_calls: toolCalls
                        });
                    } else if (textParts.length > 0) {
                        converted.push({ role: 'assistant', content: textParts.join('\n\n') });
                    }
                }
            }
        }

        return converted;
    }

    return {
        async *chat({ messages, tools, system, model, signal }) {
            const fullMessages = toOpenAIMessages(messages, system);

            const openaiTools = tools?.map(t => ({
                type: 'function',
                function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.input_schema
                }
            }));

            const stream = await client.chat.completions.create({
                model,
                messages: fullMessages,
                tools: openaiTools?.length ? openaiTools : undefined,
                stream: true,
                stream_options: { include_usage: true },
                // Enable OpenAI automatic prompt caching \u2014 identical prefixes
                // (system prompt + tools + older messages) are cached server-side,
                // reducing latency and cost on subsequent turns.
                store: true,
            }, { signal });

            let inputTokens = 0;
            let outputTokens = 0;
            let cachedTokens = 0;
            let lastFinishReason = null;
            const toolCallsByIndex = new Map();

            for await (const chunk of stream) {
                const delta = chunk.choices?.[0]?.delta;
                const finishReason = chunk.choices?.[0]?.finish_reason;

                if (delta?.content) {
                    yield { type: 'text', text: delta.content };
                }

                if (delta?.tool_calls) {
                    let fallbackIdx = 0;
                    for (const tc of delta.tool_calls) {
                        const idx = toToolCallIndex(tc.index, fallbackIdx);
                        fallbackIdx = idx + 1;
                        const existing = toolCallsByIndex.get(idx) || { id: null, name: null, args: '' };
                        if (tc.id) existing.id = tc.id;
                        if (tc.function?.name) existing.name = tc.function.name;
                        if (tc.function?.arguments) existing.args += tc.function.arguments;
                        toolCallsByIndex.set(idx, existing);
                    }
                }

                if (finishReason) {
                    lastFinishReason = finishReason;
                }

                if (chunk.usage) {
                    inputTokens = chunk.usage.prompt_tokens || 0;
                    outputTokens = chunk.usage.completion_tokens || 0;
                    // OpenAI automatic caching reports cached tokens in prompt_tokens_details
                    if (chunk.usage.prompt_tokens_details?.cached_tokens) {
                        cachedTokens = chunk.usage.prompt_tokens_details.cached_tokens;
                    }
                }
            }

            if (lastFinishReason === 'tool_calls' && toolCallsByIndex.size > 0) {
                const orderedCalls = Array.from(toolCallsByIndex.entries()).sort((a, b) => a[0] - b[0]);
                for (const [index, tc] of orderedCalls) {
                    if (!tc.name) continue;
                    yield { type: 'tool_use_start', id: tc.id || `openai_tool_${index}`, name: tc.name };
                    yield { type: 'tool_use_delta', json: tc.args || '{}' };
                    yield { type: 'content_block_stop', index };
                }
            }

            yield {
                type: 'done',
                stopReason: lastFinishReason === 'tool_calls' ? 'tool_use'
                    : lastFinishReason === 'length' ? 'max_tokens'
                    : (lastFinishReason || 'end_turn'),
                usage: { inputTokens, outputTokens, cacheReadInputTokens: cachedTokens }
            };
        },

        async validateKey() {
            try {
                await client.models.list();
                return { valid: true };
            } catch (err) {
                if (err.status === 401) return { valid: false, error: 'Invalid API key' };
                return { valid: true };
            }
        }
    };
}

// --- Google / Gemini BYOK ---

function toGeminiMessages(messages, system) {
    const contents = [];

    // Helper: find the tool name from a preceding assistant message
    function findToolName(toolUseId) {
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
            for (const block of m.content) {
                if (block.type === 'tool_use' && block.id === toolUseId) return block.name;
            }
        }
        return null;
    }

    for (const msg of messages) {
        if (msg.role === 'user') {
            if (Array.isArray(msg.content)) {
                const parts = [];
                for (const block of msg.content) {
                    if (!block || typeof block !== 'object') continue;
                    if (block.type === 'text' && block.text?.trim()) {
                        parts.push({ text: block.text });
                    }
                    if (block.type === 'tool_result' && block.tool_use_id) {
                        const resultContent = typeof block.content === 'string'
                            ? block.content
                            : JSON.stringify(block.content || {});
                        let responseData;
                        try {
                            responseData = JSON.parse(resultContent);
                        } catch (err) {
                            responseData = { result: resultContent };
                            log.debug('Gemini conversion: failed to parse tool_result JSON, using raw fallback', {
                                toolUseId: block.tool_use_id,
                                error: err?.message
                            });
                        }
                        parts.push({
                            functionResponse: {
                                name: findToolName(block.tool_use_id) || block.tool_use_id,
                                response: responseData
                            }
                        });
                    }
                }
                if (parts.length > 0) contents.push({ role: 'user', parts });
            } else if (typeof msg.content === 'string' && msg.content.trim()) {
                contents.push({ role: 'user', parts: [{ text: msg.content }] });
            }
            continue;
        }

        if (msg.role === 'assistant') {
            const parts = [];
            if (Array.isArray(msg.content)) {
                for (const block of msg.content) {
                    if (!block || typeof block !== 'object') continue;
                    if (block.type === 'text' && block.text?.trim()) {
                        parts.push({ text: block.text });
                    }
                    if (block.type === 'tool_use' && block.name) {
                        const part = {
                            functionCall: {
                                name: block.name,
                                args: block.input || {}
                            }
                        };
                        if (block.thought_signature) part.thoughtSignature = block.thought_signature;
                        parts.push(part);
                    }
                }
            } else if (typeof msg.content === 'string' && msg.content.trim()) {
                parts.push({ text: msg.content });
            }
            if (parts.length > 0) contents.push({ role: 'model', parts });
        }
    }

    return contents;
}

async function createGoogleProvider(apiKey) {
    return {
        async *chat({ messages, tools, system, model, signal }) {
            const contents = toGeminiMessages(messages, system);

            const geminiTools = tools?.map(t => ({
                name: t.name,
                description: t.description,
                parameters: t.input_schema
            }));

            const requestBody = {
                contents,
                generationConfig: { maxOutputTokens: getMaxOutputTokens(model) },
            };

            if (system) {
                requestBody.systemInstruction = { parts: [{ text: system }] };
            }

            if (geminiTools?.length) {
                requestBody.tools = [{ functionDeclarations: geminiTools }];
            }

            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

            const response = await net.fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
                signal
            });

            if (!response.ok) {
                const text = await response.text();
                throw Object.assign(new Error(`Google API error: ${text}`), { status: response.status });
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let inputTokens = 0;
            let outputTokens = 0;
            let cachedTokens = 0;
            let lastFinishReason = null;
            let hadFunctionCalls = false;

            while (true) {
                const { done: readerDone, value } = await reader.read();
                if (readerDone) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const data = line.slice(6);
                    if (data === '[DONE]') continue;

                    try {
                        const event = JSON.parse(data);

                        if (event.usageMetadata) {
                            inputTokens = event.usageMetadata.promptTokenCount || 0;
                            outputTokens = event.usageMetadata.candidatesTokenCount || 0;
                            // Gemini 2.5+ reports cached token counts when implicit caching kicks in
                            cachedTokens = event.usageMetadata.cachedContentTokenCount || 0;
                        }

                        const candidate = event.candidates?.[0];
                        if (!candidate) continue;

                        if (candidate.finishReason) {
                            lastFinishReason = candidate.finishReason;
                        }

                        const parts = candidate.content?.parts;
                        if (parts) {
                            for (const part of parts) {
                                if (part.text) {
                                    yield { type: 'text', text: part.text };
                                }
                                if (part.functionCall) {
                                    hadFunctionCalls = true;
                                    const callId = part.functionCall.id || `gemini_${part.functionCall.name}_${Date.now()}`;
                                    yield { type: 'tool_use_start', id: callId, name: part.functionCall.name, thought_signature: part.thoughtSignature || null };
                                    yield { type: 'tool_use_delta', json: JSON.stringify(part.functionCall.args || {}) };
                                    yield { type: 'content_block_stop', index: 0 };
                                }
                            }
                        }
                    } catch (err) {
                        log.debug('Gemini SSE parse skipped unparseable event', {
                            error: err?.message,
                            preview: typeof data === 'string' ? data.slice(0, 200) : null
                        });
                    }
                }
            }

            // Gemini returns STOP even when functionCall parts are present.
            // Map to tool_use when we saw function calls so the agentic loop
            // and trace logging accurately reflect what happened.
            const stopReason = hadFunctionCalls ? 'tool_use'
                : lastFinishReason === 'STOP' ? 'end_turn'
                : lastFinishReason === 'MAX_TOKENS' ? 'max_tokens'
                : (lastFinishReason?.toLowerCase() || 'end_turn');

            yield {
                type: 'done',
                stopReason,
                usage: { inputTokens, outputTokens, cacheReadInputTokens: cachedTokens }
            };
        },

        async validateKey() {
            try {
                const res = await net.fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
                if (!res.ok) {
                    if (res.status === 400 || res.status === 403) return { valid: false, error: 'Invalid API key' };
                }
                return { valid: true };
            } catch (err) {
                log.debug('Google validateKey request failed; treating as transient for validation UX', {
                    error: err?.message
                });
                return { valid: true };
            }
        }
    };
}

// --- Provider Factory ---

export async function createProvider(providerId, apiKey) {
    switch (providerId) {
        case 'anthropic': return createAnthropicProvider(apiKey);
        case 'openai': return createOpenAIProvider(apiKey);
        case 'google': return createGoogleProvider(apiKey);
        default: throw new Error(`Unknown provider: ${providerId}`);
    }
}
