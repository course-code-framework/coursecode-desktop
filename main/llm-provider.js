import { app, net, safeStorage } from 'electron';
import { join } from 'path';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { isLocalMode } from './node-env.js';
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
            'claude-3-5-sonnet-latest': { input: 3, output: 15 }
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
        .map(m => m?.id)
        .filter(id => typeof id === 'string' && id.startsWith('claude-'))
        .map(id => ({ id, label: labelFromModelId(id) }));

    return markDefaultModel(discovered, [
        'claude-3-5-sonnet-latest',
        'claude-3-7-sonnet-latest'
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
        .map(m => m?.name?.replace('models/', ''))
        .filter(id => typeof id === 'string' && id.startsWith('gemini-'))
        .map(id => ({ id, label: labelFromModelId(id) }));

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
            const stream = client.messages.stream({
                model,
                max_tokens: MAX_TOKENS,
                system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
                messages,
                tools: tools || [],
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
            }, { signal });

            let inputTokens = 0;
            let outputTokens = 0;
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
                stopReason: lastFinishReason === 'tool_calls' ? 'tool_use' : (lastFinishReason || 'stop'),
                usage: { inputTokens, outputTokens }
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
                        try { responseData = JSON.parse(resultContent); } catch { responseData = { result: resultContent }; }
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
                        parts.push({
                            functionCall: {
                                name: block.name,
                                args: block.input || {}
                            }
                        });
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
                generationConfig: { maxOutputTokens: MAX_TOKENS },
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
                                    yield { type: 'tool_use_start', id: callId, name: part.functionCall.name };
                                    yield { type: 'tool_use_delta', json: JSON.stringify(part.functionCall.args || {}) };
                                    yield { type: 'content_block_stop', index: 0 };
                                }
                            }
                        }
                    } catch { /* skip unparseable */ }
                }
            }

            const stopReason = lastFinishReason === 'STOP' ? 'end_turn'
                : lastFinishReason === 'MAX_TOKENS' ? 'max_tokens'
                : (lastFinishReason?.toLowerCase() || 'end_turn');

            yield {
                type: 'done',
                stopReason: stopReason === 'tool_use' ? 'tool_use' : stopReason,
                usage: { inputTokens, outputTokens }
            };
        },

        async validateKey() {
            try {
                const res = await net.fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
                if (!res.ok) {
                    if (res.status === 400 || res.status === 403) return { valid: false, error: 'Invalid API key' };
                }
                return { valid: true };
            } catch {
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
function formatToolsForProvider(tools, cloudProvider) {
    if (!tools) return tools;
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

async function createCloudProxyProvider(token, cloudProvider) {
    const baseUrl = getCloudBaseUrl();

    return {
        async *chat({ messages, tools, system, model, signal }) {
            const formattedTools = formatToolsForProvider(tools, cloudProvider);
            const body = { model, messages, tools: formattedTools, system, max_tokens: MAX_TOKENS };

            // Compose a timeout abort with the user's signal
            const fetchController = new AbortController();
            const onUserAbort = () => fetchController.abort();
            signal?.addEventListener('abort', onUserAbort);

            // 30s timeout for the initial connection/response
            const connectTimeout = setTimeout(() => fetchController.abort(), 30_000);

            let res;
            try {
                log.debug('Cloud proxy: fetching', { url: `${baseUrl}/api/ai/chat`, model });
                res = await net.fetch(`${baseUrl}/api/ai/chat`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(body),
                    signal: fetchController.signal
                });
                log.debug('Cloud proxy: response received', { status: res.status, contentType: res.headers.get('content-type') });
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
                if (res.status === 401) throw Object.assign(new Error('Not signed in to CourseCode Cloud'), { status: 401 });
                if (res.status === 402) {
                    if (looksLikeNoCreditsError(errorCode, message)) {
                        throw Object.assign(new Error(message || 'Insufficient credits'), { status: 402, code: 'NO_CREDITS', errorCode });
                    }
                    throw Object.assign(new Error(message || 'Cloud AI request requires billing action.'), { status: 402, code: errorCode || 'BILLING_REQUIRED', errorCode });
                }
                if (res.status === 503) throw Object.assign(new Error('This AI model is temporarily unavailable. Try a different model.'), { status: 503 });
                if (res.status === 504) throw Object.assign(new Error('The AI service took too long to respond. Try again in a moment.'), { status: 504 });
                log.error('Cloud proxy error', { status: res.status, message, detail });
                throw Object.assign(new Error(message || `Cloud proxy error: HTTP ${res.status}`), { status: res.status, code: errorCode || undefined, errorCode });
            }

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
                            yield { type: 'tool_use_start', id: event.id, name: event.name };
                            if (event.input) {
                                yield { type: 'tool_use_delta', json: JSON.stringify(event.input) };
                            }
                            yield { type: 'content_block_stop', index: 0 };
                        } else if (event.type === 'done' || event.done === true) {
                            if (event.stop_reason === 'timeout') {
                                log.warn('Cloud proxy: upstream provider timed out');
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
    return data?.models || [];
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

export async function createProvider(providerId, apiKeyOrToken, { cloudProvider } = {}) {
    switch (providerId) {
        case 'anthropic': return createAnthropicProvider(apiKeyOrToken);
        case 'openai': return createOpenAIProvider(apiKeyOrToken);
        case 'google': return createGoogleProvider(apiKeyOrToken);
        case 'cloud': return createCloudProxyProvider(apiKeyOrToken, cloudProvider);
        default: throw new Error(`Unknown provider: ${providerId}`);
    }
}
