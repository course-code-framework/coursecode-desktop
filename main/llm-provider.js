import { app, net, safeStorage } from 'electron';
import { join } from 'path';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { isLocalMode } from './node-env.js';
import { MAX_TOKENS } from './ai-config.js';
import { createLogger } from './logger.js';

const log = createLogger('ai');
const verboseAiDiagnostics = !app.isPackaged && /^(1|true|yes)$/i.test(String(process.env.COURSECODE_VERBOSE_AI_DIAGNOSTICS || '0'));

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
    return !!loadApiKey(provider);
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
        .map(id => ({ id, label: labelFromModelId(id) }));

    return markDefaultModel(discovered, ['gpt-4o', 'o3']);
}

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

export async function getProviders() {
    const entries = await Promise.all(Object.entries(providers).map(async ([id, p]) => {
        const hasKey = hasApiKey(id);
        let models = [];
        let modelFetchFailed = false;
        let modelFetchError = null;
        const key = loadApiKey(id);

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

                    for (const block of msg.content) {
                        if (!block || typeof block !== 'object') continue;

                        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
                            textParts.push(block.text);
                        }

                        if (block.type === 'tool_result' && block.tool_use_id) {
                            const resultContent = typeof block.content === 'string'
                                ? block.content
                                : JSON.stringify(block.content || {});
                            converted.push({
                                role: 'tool',
                                tool_call_id: block.tool_use_id,
                                content: resultContent
                            });
                        }
                    }

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

            const stopReason = lastFinishReason === 'STOP' ? 'end_turn'
                : lastFinishReason === 'MAX_TOKENS' ? 'max_tokens'
                : (lastFinishReason?.toLowerCase() || 'end_turn');

            yield {
                type: 'done',
                stopReason: stopReason === 'tool_use' ? 'tool_use' : stopReason,
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

// --- Cloud Proxy ---

function getCloudBaseUrl() {
    return isLocalMode() ? 'http://localhost:3000' : 'https://coursecodecloud.com';
}

function extractCloudErrorDetails(payload, status) {
    if (!payload || typeof payload !== 'object') {
        return {
            message: `Cloud proxy error: HTTP ${status}`,
            errorCode: null,
            detail: null
        };
    }

    const rawError = payload.error || payload.message || `Cloud proxy error: HTTP ${status}`;
    const detail = payload.detail || null;
    // When the proxy returns a generic error string alongside a detail (the upstream provider's
    // actual rejection reason), combine them so the user sees what actually went wrong.
    const message = detail ? `${rawError}: ${detail}` : rawError;
    const errorCode = payload.errorCode || payload.error_code || payload.code || null;

    return { message, errorCode, detail };
}

function looksLikeNoCreditsError(errorCode, message) {
    const normalizedCode = String(errorCode || '').toLowerCase();
    const normalizedMessage = String(message || '').toLowerCase();

    return (
        normalizedCode === 'no_credits'
        || normalizedCode === 'credits_exhausted'
        || normalizedCode === 'insufficient_credits'
        || normalizedCode === 'out_of_credits'
        || normalizedMessage.includes('out of credits')
        || normalizedMessage.includes('insufficient credits')
        || normalizedMessage.includes('not enough credits')
        || normalizedMessage.includes('credits exhausted')
        || normalizedMessage.includes('no credits')
    );
}

/**
 * Translate tool definitions from internal Anthropic format to the target provider's format.
 * Internal tools use { name, description, input_schema }, which matches Anthropic's API.
 * OpenAI requires { type: 'function', function: { name, description, parameters } }.
 */
function formatToolsForProvider(tools, cloudProvider, cloudApiType) {
    if (!tools) return tools;
    if (cloudApiType === 'responses') {
        // Responses API: { type: 'function', name, parameters }
        return tools.map(t => ({
            type: 'function',
            name: t.name,
            description: t.description,
            parameters: t.input_schema
        }));
    }
    if (cloudProvider === 'openai') {
        return tools.map(t => ({
            type: 'function',
            function: {
                name: t.name,
                description: t.description,
                parameters: t.input_schema
            }
        }));
    }
    if (cloudProvider === 'google') {
        return tools.map(t => ({
            name: t.name,
            description: t.description,
            parameters: t.input_schema
        }));
    }
    return tools;
}

function validateCloudProxyBody(body, cloudProvider, cloudApiType) {
    const issues = [];

    if (!body || typeof body !== 'object') {
        return ['request body must be an object'];
    }

    if (typeof body.model !== 'string' || !body.model.trim()) {
        issues.push('model must be a non-empty string');
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
        issues.push('messages must be a non-empty array');
    }
    if (typeof body.system !== 'string' && !Array.isArray(body.system)) {
        issues.push('system must be a string or content block array');
    }

    if (body.tools != null && !Array.isArray(body.tools)) {
        issues.push('tools must be an array when present');
    }

    if (cloudApiType === 'responses' && Array.isArray(body.messages)) {
        for (let i = 0; i < body.messages.length; i++) {
            const item = body.messages[i];
            const prefix = `messages[${i}]`;

            if (!item || typeof item !== 'object') {
                issues.push(`${prefix} must be an object`);
                continue;
            }

            const isRoleMessage = (item.role === 'user' || item.role === 'assistant')
                && (typeof item.content === 'string' || Array.isArray(item.content));
            const isFunctionCall = item.type === 'function_call'
                && typeof item.call_id === 'string' && item.call_id.trim()
                && typeof item.name === 'string' && item.name.trim()
                && typeof item.arguments === 'string';
            const outputType = typeof item.output;
            const isFunctionCallOutput = item.type === 'function_call_output'
                && typeof item.call_id === 'string' && item.call_id.trim()
                && (
                    outputType === 'string'
                    || outputType === 'number'
                    || outputType === 'boolean'
                    || outputType === 'object'
                );

            if (!isRoleMessage && !isFunctionCall && !isFunctionCallOutput) {
                issues.push(`${prefix} is not a valid responses input item`);
            }
        }

        if (Array.isArray(body.tools)) {
            for (let i = 0; i < body.tools.length; i++) {
                const tool = body.tools[i];
                const prefix = `tools[${i}]`;
                const valid = tool
                    && typeof tool === 'object'
                    && tool.type === 'function'
                    && typeof tool.name === 'string' && tool.name.trim()
                    && tool.parameters
                    && typeof tool.parameters === 'object'
                    && !Array.isArray(tool.parameters);

                if (!valid) {
                    issues.push(`${prefix} is not a valid responses function tool definition`);
                }
            }
        }
    }

    if (cloudProvider === 'openai' && cloudApiType !== 'responses' && Array.isArray(body.tools)) {
        for (let i = 0; i < body.tools.length; i++) {
            const tool = body.tools[i];
            const prefix = `tools[${i}]`;
            const valid = tool
                && typeof tool === 'object'
                && tool.type === 'function'
                && tool.function
                && typeof tool.function === 'object'
                && typeof tool.function.name === 'string' && tool.function.name.trim();
            if (!valid) {
                issues.push(`${prefix} is not a valid openai function tool definition`);
            }
        }
    }

    return issues;
}

function assertCloudProxyBodyValid(body, cloudProvider, cloudApiType, requestId, phase) {
    const issues = validateCloudProxyBody(body, cloudProvider, cloudApiType);
    if (issues.length === 0) return;

    const summary = issues.slice(0, 8).join('; ');
    log.error('Cloud proxy local payload validation failed', {
        requestId,
        phase,
        cloudProvider,
        cloudApiType,
        issueCount: issues.length,
        issues: verboseAiDiagnostics ? issues.slice(0, 50) : issues.slice(0, 8),
        bodyKeys: Object.keys(body || {}),
        messageCount: Array.isArray(body?.messages) ? body.messages.length : null,
        toolCount: Array.isArray(body?.tools) ? body.tools.length : null
    });

    throw Object.assign(
        new Error(`Cloud request payload validation failed (${phase}): ${summary}`),
        { code: 'CLOUD_PAYLOAD_VALIDATION_FAILED' }
    );
}

function normalizeResponsesMessagesForRetry(messages = []) {
    const normalized = [];

    for (const item of messages) {
        if (!item || typeof item !== 'object') continue;

        if (item.type === 'function_call_output') {
            let nextOutput = item.output;
            if (typeof nextOutput === 'string') {
                try {
                    nextOutput = JSON.parse(nextOutput);
                } catch {
                    // Keep string output if it is not JSON.
                }
            }

            normalized.push({
                type: 'function_call_output',
                call_id: item.call_id,
                output: nextOutput
            });
            continue;
        }

        normalized.push(item);
    }

    return normalized;
}

function compactResponsesMessagesForRetry(messages = []) {
    const roleMessages = [];

    for (const item of messages) {
        if (!item || typeof item !== 'object') continue;
        if (item.role === 'user' || item.role === 'assistant') {
            const content = item.content;
            if (typeof content === 'string' && content.trim()) {
                roleMessages.push({ role: item.role, content });
            }
        }
    }

    const compacted = roleMessages.slice(-4);

    // Preserve the latest function call + output so the model can continue from
    // real tool state instead of repeatedly requesting the same tool.
    let latestOutput = null;
    for (let i = messages.length - 1; i >= 0; i--) {
        const item = messages[i];
        if (item?.type === 'function_call_output' && item.call_id) {
            latestOutput = item;
            break;
        }
    }

    if (latestOutput) {
        let latestCall = null;
        for (let i = messages.length - 1; i >= 0; i--) {
            const item = messages[i];
            if (item?.type === 'function_call' && item.call_id === latestOutput.call_id) {
                latestCall = item;
                break;
            }
        }

        if (latestCall) {
            compacted.push({
                type: 'function_call',
                call_id: latestCall.call_id,
                name: latestCall.name,
                arguments: latestCall.arguments
            });
        }

        compacted.push({
            type: 'function_call_output',
            call_id: latestOutput.call_id,
            output: latestOutput.output
        });
    }

    return compacted;
}

const responsesCompactionModeByRequestId = new Map();

function rememberResponsesCompactionMode(requestId) {
    if (!requestId) return;
    responsesCompactionModeByRequestId.set(requestId, Date.now());

    // Keep this tiny and self-cleaning; request IDs are per-chat-turn.
    if (responsesCompactionModeByRequestId.size > 512) {
        const staleBefore = Date.now() - (30 * 60 * 1000);
        for (const [id, ts] of responsesCompactionModeByRequestId.entries()) {
            if (ts < staleBefore) {
                responsesCompactionModeByRequestId.delete(id);
            }
        }
    }
}

function shouldCompactResponsesForRequest(requestId) {
    if (!requestId) return false;
    return responsesCompactionModeByRequestId.has(requestId);
}

async function createCloudProxyProvider(token, cloudProvider, cloudApiType) {
    const baseUrl = getCloudBaseUrl();

    return {
        async *chat({ messages, tools, system, model, signal, requestId }) {
            const requestMetrics = {
                requestId: requestId || null,
                cloudProvider: cloudProvider || null,
                cloudApiType: cloudApiType || null,
                firstAttemptStatus: null,
                retryNormalizedStatus: null,
                retryCompactedStatus: null,
                fallbackUsed: 'none',
                finalStatus: null,
                finalPhase: 'initial'
            };
            let outcomeLogged = false;
            const logRequestOutcome = (result) => {
                if (outcomeLogged) return;
                outcomeLogged = true;
                log.info('Cloud proxy request outcome', {
                    ...requestMetrics,
                    result
                });
            };

            const formattedTools = formatToolsForProvider(tools, cloudProvider, cloudApiType);
            const useCompactedMessages = cloudApiType === 'responses' && shouldCompactResponsesForRequest(requestId);
            const outboundMessages = useCompactedMessages ? compactResponsesMessagesForRetry(messages) : messages;

            // Anthropic prompt caching: inject cache_control markers so the proxy
            // forwards them to Anthropic's API.  This mirrors the BYOK strategy:
            //   1. System prompt → structured content block with cache_control
            //   2. Last tool definition → cache_control marker
            //   3. Conversation boundary (message N-3) → cache_control marker
            // Without these, every request pays full input token cost for the
            // static prefix (system + tools + older history).
            let outboundSystem = system;
            let outboundTools = formattedTools;
            let cachedMessages = outboundMessages;
            if (cloudProvider === 'anthropic') {
                // System prompt as cacheable content block array
                if (system) {
                    outboundSystem = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
                }
                // Mark last tool for caching
                if (outboundTools?.length) {
                    outboundTools = outboundTools.map((t, i) =>
                        i === outboundTools.length - 1
                            ? { ...t, cache_control: { type: 'ephemeral' } }
                            : t
                    );
                }
                // Mark conversation boundary (N-3) for caching
                if (cachedMessages?.length >= 3) {
                    cachedMessages = cachedMessages.map((m, i) => {
                        if (i !== cachedMessages.length - 3 || m.role !== 'user') return m;
                        if (typeof m.content === 'string') {
                            return { ...m, content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }] };
                        }
                        if (Array.isArray(m.content) && m.content.length > 0) {
                            const lastIdx = m.content.length - 1;
                            return { ...m, content: m.content.map((block, bi) => bi === lastIdx ? { ...block, cache_control: { type: 'ephemeral' } } : block) };
                        }
                        return m;
                    });
                }
            }

            const body = {
                model,
                messages: cachedMessages,
                tools: outboundTools,
                system: outboundSystem,
                max_tokens: getMaxOutputTokens(model)
            };
            assertCloudProxyBodyValid(body, cloudProvider, cloudApiType, requestId, 'initial');
            if (verboseAiDiagnostics) {
                log.debug('Cloud proxy: request body sample', {
                    requestId,
                    firstMessage: outboundMessages?.[0] ? JSON.stringify(outboundMessages[0]).slice(0, 200) : null,
                    firstTool: formattedTools?.[0] ? JSON.stringify(formattedTools[0]).slice(0, 200) : null
                });
            }

            if (useCompactedMessages) {
                log.debug('Cloud proxy: using compacted responses history for request', {
                    requestId,
                    compactedMessageCount: outboundMessages.length,
                    originalMessageCount: messages?.length || 0
                });
            }

            // Compose a timeout abort with the user's signal
            const fetchController = new AbortController();
            const onUserAbort = () => fetchController.abort();
            signal?.addEventListener('abort', onUserAbort);

            // 30s timeout for the initial connection/response
            const connectTimeout = setTimeout(() => fetchController.abort(), 30_000);

            const requestHeaders = {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            };
            if (cloudProvider) requestHeaders['X-CourseCode-Cloud-Provider'] = cloudProvider;
            if (cloudApiType) requestHeaders['X-CourseCode-Cloud-Api-Type'] = cloudApiType;

            let res;
            try {
                if (verboseAiDiagnostics) {
                    log.debug('Cloud proxy: fetching', {
                        requestId,
                        url: `${baseUrl}/api/ai/chat`,
                        model,
                        cloudProvider,
                        cloudApiType,
                        messageCount: outboundMessages?.length,
                        toolCount: formattedTools?.length,
                        systemLength: system?.length,
                        bodyKeys: Object.keys(body)
                    });
                }

                res = await net.fetch(`${baseUrl}/api/ai/chat`, {
                    method: 'POST',
                    headers: requestHeaders,
                    body: JSON.stringify(body),
                    signal: fetchController.signal
                });
                requestMetrics.firstAttemptStatus = res.status;
                log.debug('Cloud proxy: response received', { requestId, status: res.status, contentType: res.headers.get('content-type') });
            } catch (err) {
                if (fetchController.signal.aborted && !signal?.aborted) {
                    throw new Error('Cloud proxy timed out — the server took too long to respond. Check that your cloud app is running and responsive.');
                }
                throw err;
            } finally {
                clearTimeout(connectTimeout);
                signal?.removeEventListener('abort', onUserAbort);
            }

            if (!res.ok) {
                const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
                const { message, errorCode } = extractCloudErrorDetails(errBody, res.status);
                const detail = errBody?.detail;

                // Some OpenAI Responses payload validators are strict about function_call_output
                // shape. If we hit a 400 invalid-body response, retry once with normalized output.
                if (
                    res.status === 400
                    && cloudApiType === 'responses'
                    && /invalid request body/i.test(message || '')
                ) {
                    rememberResponsesCompactionMode(requestId);
                    const retryMessages = normalizeResponsesMessagesForRetry(messages);
                    const retryBody = {
                        ...body,
                        messages: retryMessages
                    };
                    assertCloudProxyBodyValid(retryBody, cloudProvider, cloudApiType, requestId, 'retry-normalized-output');

                    log.warn('Cloud proxy 400 on responses payload; retrying with normalized function_call_output', {
                        requestId,
                        originalMessageCount: messages?.length || 0,
                        retryMessageCount: retryMessages.length
                    });

                    const retryRes = await net.fetch(`${baseUrl}/api/ai/chat`, {
                        method: 'POST',
                        headers: requestHeaders,
                        body: JSON.stringify(retryBody),
                        signal: fetchController.signal
                    });
                    requestMetrics.retryNormalizedStatus = retryRes.status;

                    if (retryRes.ok) {
                        requestMetrics.fallbackUsed = 'normalized';
                        requestMetrics.finalPhase = 'retry-normalized-output';
                        log.info('Cloud proxy retry succeeded after response payload normalization', {
                            requestId,
                            status: retryRes.status
                        });
                        res = retryRes;
                    } else {
                        const retryErrBody = await retryRes.json().catch(() => ({ error: `HTTP ${retryRes.status}` }));
                        const retryExtracted = extractCloudErrorDetails(retryErrBody, retryRes.status);
                        log.error('Cloud proxy retry failed', {
                            requestId,
                            status: retryRes.status,
                            message: retryExtracted.message,
                            detail: retryErrBody?.detail,
                            rawBody: JSON.stringify(retryErrBody)
                        });

                        // Final fallback: drop tool-call transcript items and retry with text-only
                        // role messages. This recovers from strict validator failures on mixed
                        // function_call/function_call_output history from previous interrupted turns.
                        if (retryRes.status === 400 && /invalid request body/i.test(retryExtracted.message || '')) {
                            const compactedMessages = compactResponsesMessagesForRetry(messages);
                            const compactedBody = {
                                ...body,
                                messages: compactedMessages
                            };
                            assertCloudProxyBodyValid(compactedBody, cloudProvider, cloudApiType, requestId, 'retry-compacted-history');

                            log.warn('Cloud proxy 2nd retry: sending compacted responses history', {
                                requestId,
                                compactedMessageCount: compactedMessages.length,
                                originalMessageCount: messages?.length || 0
                            });

                            const retry2Res = await net.fetch(`${baseUrl}/api/ai/chat`, {
                                method: 'POST',
                                headers: requestHeaders,
                                body: JSON.stringify(compactedBody),
                                signal: fetchController.signal
                            });
                            requestMetrics.retryCompactedStatus = retry2Res.status;

                            if (retry2Res.ok) {
                                requestMetrics.fallbackUsed = 'compacted';
                                requestMetrics.finalPhase = 'retry-compacted-history';
                                log.info('Cloud proxy second retry succeeded with compacted responses history', {
                                    requestId,
                                    status: retry2Res.status
                                });
                                res = retry2Res;
                            } else {
                                const retry2ErrBody = await retry2Res.json().catch(() => ({ error: `HTTP ${retry2Res.status}` }));
                                const retry2Extracted = extractCloudErrorDetails(retry2ErrBody, retry2Res.status);
                                log.error('Cloud proxy second retry failed', {
                                    requestId,
                                    status: retry2Res.status,
                                    message: retry2Extracted.message,
                                    detail: retry2ErrBody?.detail,
                                    rawBody: JSON.stringify(retry2ErrBody)
                                });
                            }
                        }
                    }
                }

                // If retry succeeded, continue normal stream processing below.
                if (res.ok) {
                    // no-op: fall through to stream handling after this block
                } else if (res.status === 401) {
                    requestMetrics.finalStatus = res.status;
                    logRequestOutcome('error');
                    throw Object.assign(new Error('Not signed in to CourseCode Cloud'), { status: 401 });
                }
                else if (res.status === 402) {
                    requestMetrics.finalStatus = res.status;
                    logRequestOutcome('error');
                    if (looksLikeNoCreditsError(errorCode, message)) {
                        throw Object.assign(new Error(message || 'Insufficient credits'), { status: 402, code: 'NO_CREDITS', errorCode });
                    }
                    throw Object.assign(new Error(message || 'Cloud AI request requires billing action.'), { status: 402, code: errorCode || 'BILLING_REQUIRED', errorCode });
                }
                else if (res.status === 503) {
                    requestMetrics.finalStatus = res.status;
                    logRequestOutcome('error');
                    throw Object.assign(new Error('This AI model is temporarily unavailable. Try a different model.'), { status: 503 });
                }
                else if (res.status === 504) {
                    requestMetrics.finalStatus = res.status;
                    logRequestOutcome('error');
                    throw Object.assign(new Error('The AI service took too long to respond. Try again in a moment.'), { status: 504 });
                }
                else {
                    requestMetrics.finalStatus = res.status;
                    logRequestOutcome('error');
                    log.error('Cloud proxy error', { requestId, status: res.status, message, detail, rawBody: JSON.stringify(errBody) });
                    throw Object.assign(new Error(message || `Cloud proxy error: HTTP ${res.status}`), { status: res.status, code: errorCode || undefined, errorCode });
                }
            }

            requestMetrics.finalStatus = res.status;
            logRequestOutcome('success');

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            // 60s idle timeout — if no SSE data arrives for this long, abort
            const IDLE_TIMEOUT = 60_000;
            let idleTimer;
            const resetIdle = () => {
                clearTimeout(idleTimer);
                idleTimer = setTimeout(() => {
                    log.warn('Cloud proxy: SSE stream idle timeout — no data for 60s');
                    reader.cancel();
                }, IDLE_TIMEOUT);
            };
            resetIdle();

            try {
                while (true) {
                    const { done: readerDone, value } = await reader.read();
                    if (readerDone) break;
                    resetIdle();

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        if (!line.startsWith('data: ')) continue;
                        const event = JSON.parse(line.slice(6));

                        if (event.type === 'text') {
                            yield { type: 'text', text: event.content };
                        } else if (event.type === 'tool_use') {
                            yield { type: 'tool_use_start', id: event.id, name: event.name, thought_signature: event.thought_signature || null };
                            if (event.input) {
                                yield { type: 'tool_use_delta', json: JSON.stringify(event.input) };
                            }
                            yield { type: 'content_block_stop', index: 0 };
                        } else if (event.type === 'done' || event.done === true) {
                            if (event.stop_reason === 'timeout') {
                                log.warn('Cloud proxy: upstream provider timed out', { requestId });
                            }
                            yield {
                                type: 'done',
                                stopReason: event.stop_reason || (event.done ? 'end_turn' : undefined),
                                timedOut: event.stop_reason === 'timeout',
                                usage: {
                                    inputTokens: event.usage?.input || 0,
                                    outputTokens: event.usage?.output || 0
                                },
                                creditsCharged: event.credits_charged || 0
                            };
                        }
                    }
                }
            } finally {
                clearTimeout(idleTimer);
            }
        },

        async validateKey() {
            try {
                await net.fetch(`${baseUrl}/api/ai/models`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                }).then(r => { if (!r.ok) throw { status: r.status }; });
                return { valid: true };
            } catch (err) {
                if (err.status === 401) return { valid: false, error: 'Invalid or expired token' };
                return { valid: true };
            }
        }
    };
}

export async function getCloudModels(token) {
    const baseUrl = getCloudBaseUrl();
    const res = await net.fetch(`${baseUrl}/api/ai/models`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) {
        if (res.status === 401) throw Object.assign(new Error('Not authenticated'), { status: 401 });
        throw new Error(`Failed to fetch models: HTTP ${res.status}`);
    }
    const data = await res.json();
    const models = data?.models || [];

    // Populate dynamic limits from cloud model metadata
    for (const m of models) {
        if (m.id && m.maxOutputTokens) modelOutputLimits.set(m.id, m.maxOutputTokens);
    }

    return models;
}

export async function getCloudUsage(token) {
    const baseUrl = getCloudBaseUrl();
    const res = await net.fetch(`${baseUrl}/api/ai/usage`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) {
        if (res.status === 401) throw Object.assign(new Error('Not authenticated'), { status: 401 });
        throw new Error(`Failed to fetch usage: HTTP ${res.status}`);
    }
    return res.json();
}

// --- Provider Factory ---

export async function createProvider(providerId, apiKeyOrToken, { cloudProvider, cloudApiType } = {}) {
    switch (providerId) {
        case 'anthropic': return createAnthropicProvider(apiKeyOrToken);
        case 'openai': return createOpenAIProvider(apiKeyOrToken);
        case 'google': return createGoogleProvider(apiKeyOrToken);
        case 'cloud': return createCloudProxyProvider(apiKeyOrToken, cloudProvider, cloudApiType);
        default: throw new Error(`Unknown provider: ${providerId}`);
    }
}

export const __testables = {
    formatToolsForProvider,
    validateCloudProxyBody,
    normalizeResponsesMessagesForRetry,
    compactResponsesMessagesForRetry
};
