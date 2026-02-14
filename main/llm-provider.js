import { app, safeStorage } from 'electron';
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
        models: [
            { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4', default: true },
            { id: 'claude-opus-4-20250514', label: 'Claude Opus 4' }
        ],
        keyPlaceholder: 'sk-ant-...',
        keyPattern: /^sk-ant-/,
        docs: 'https://console.anthropic.com/settings/keys',
        pricing: {
            'claude-sonnet-4-20250514': { input: 3, output: 15 },   // per 1M tokens
            'claude-opus-4-20250514': { input: 15, output: 75 }
        }
    },
    openai: {
        name: 'OpenAI',
        models: [
            { id: 'gpt-4o', label: 'GPT-4o', default: true },
            { id: 'o3', label: 'o3' }
        ],
        keyPlaceholder: 'sk-...',
        keyPattern: /^sk-/,
        docs: 'https://platform.openai.com/api-keys',
        pricing: {
            'gpt-4o': { input: 2.5, output: 10 },
            'o3': { input: 10, output: 40 }
        }
    }
};

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

export function getProviders() {
    return Object.entries(providers).map(([id, p]) => ({
        id,
        name: p.name,
        models: p.models.map(m => {
            const pricing = p.pricing?.[m.id];
            return { ...m, costScore: pricing ? pricing.input + pricing.output : null };
        }),
        keyPlaceholder: p.keyPlaceholder,
        docs: p.docs,
        hasKey: hasApiKey(id)
    }));
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
                await client.messages.create({
                    model: 'claude-sonnet-4-20250514',
                    max_tokens: 1,
                    messages: [{ role: 'user', content: 'hi' }]
                });
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

    return {
        async *chat({ messages, tools, system, model, signal }) {
            // OpenAI uses system message in messages array
            const fullMessages = [
                { role: 'system', content: system },
                ...messages
            ];

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
            }, { signal });

            let currentToolCall = null;
            let inputTokens = 0;
            let outputTokens = 0;

            for await (const chunk of stream) {
                const delta = chunk.choices?.[0]?.delta;
                const finishReason = chunk.choices?.[0]?.finish_reason;

                if (delta?.content) {
                    yield { type: 'text', text: delta.content };
                }

                if (delta?.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        if (tc.id) {
                            currentToolCall = { id: tc.id, name: tc.function?.name };
                            yield { type: 'tool_use_start', id: tc.id, name: tc.function?.name };
                        }
                        if (tc.function?.arguments) {
                            yield { type: 'tool_use_delta', json: tc.function.arguments };
                        }
                    }
                }

                if (finishReason === 'tool_calls') {
                    yield { type: 'content_block_stop', index: 0 };
                }

                if (chunk.usage) {
                    inputTokens = chunk.usage.prompt_tokens || 0;
                    outputTokens = chunk.usage.completion_tokens || 0;
                }

                if (finishReason) {
                    yield {
                        type: 'done',
                        stopReason: finishReason,
                        usage: { inputTokens, outputTokens }
                    };
                }
            }
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

// --- Cloud Proxy ---

function getCloudBaseUrl() {
    return isLocalMode() ? 'http://localhost:3000' : 'https://coursecodecloud.com';
}

async function createCloudProxyProvider(token) {
    const baseUrl = getCloudBaseUrl();

    return {
        async *chat({ messages, tools, system, model, signal }) {
            const body = { model, messages, tools, system, max_tokens: MAX_TOKENS };

            // Compose a timeout abort with the user's signal
            const fetchController = new AbortController();
            const onUserAbort = () => fetchController.abort();
            signal?.addEventListener('abort', onUserAbort);

            // 30s timeout for the initial connection/response
            const connectTimeout = setTimeout(() => fetchController.abort(), 30_000);

            let res;
            try {
                log.debug('Cloud proxy: fetching', { url: `${baseUrl}/api/ai/chat`, model });
                res = await fetch(`${baseUrl}/api/ai/chat`, {
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
                const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
                if (res.status === 401) throw Object.assign(new Error('Not signed in to CourseCode Cloud'), { status: 401 });
                if (res.status === 402) throw Object.assign(new Error(err.error || 'Insufficient credits'), { status: 402 });
                throw new Error(err.error || `Cloud proxy error: HTTP ${res.status}`);
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
                            yield {
                                type: 'done',
                                stopReason: event.stop_reason || (event.done ? 'end_turn' : undefined),
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
                await fetch(`${baseUrl}/api/ai/models`, {
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
    const res = await fetch(`${baseUrl}/api/ai/models`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) {
        if (res.status === 401) throw Object.assign(new Error('Not authenticated'), { status: 401 });
        throw new Error(`Failed to fetch models: HTTP ${res.status}`);
    }
    const data = await res.json();
    return data.models || [];
}

export async function getCloudUsage(token) {
    const baseUrl = getCloudBaseUrl();
    const res = await fetch(`${baseUrl}/api/ai/usage`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) {
        if (res.status === 401) throw Object.assign(new Error('Not authenticated'), { status: 401 });
        throw new Error(`Failed to fetch usage: HTTP ${res.status}`);
    }
    return res.json();
}

// --- Provider Factory ---

export async function createProvider(providerId, apiKeyOrToken) {
    switch (providerId) {
        case 'anthropic': return createAnthropicProvider(apiKeyOrToken);
        case 'openai': return createOpenAIProvider(apiKeyOrToken);
        case 'cloud': return createCloudProxyProvider(apiKeyOrToken);
        default: throw new Error(`Unknown provider: ${providerId}`);
    }
}
