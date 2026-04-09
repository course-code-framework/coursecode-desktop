import { describe, it, expect, vi } from 'vitest';
import fixtures from '../fixtures/llm-provider-contract-fixtures.json';

vi.mock('electron', () => import('../mocks/electron.js'));

const { __testables } = await import('../../main/llm-provider.js');

const {
    formatToolsForProvider,
    validateCloudProxyBody,
    normalizeResponsesMessagesForRetry,
    compactResponsesMessagesForRetry
} = __testables;

describe('llm-provider adapter contract fixtures', () => {
    it('accepts valid responses payload fixture', () => {
        const issues = validateCloudProxyBody(
            fixtures.responses.validBody,
            'openai',
            'responses'
        );
        expect(issues).toEqual([]);
    });

    it('rejects invalid responses message fixture', () => {
        const issues = validateCloudProxyBody(
            fixtures.responses.invalidBodyBadMessage,
            'openai',
            'responses'
        );
        expect(issues.length).toBeGreaterThan(0);
        expect(issues.join(' | ')).toContain('messages[1]');
    });

    it('rejects invalid responses tool fixture', () => {
        const issues = validateCloudProxyBody(
            fixtures.responses.invalidBodyBadTool,
            'openai',
            'responses'
        );
        expect(issues.length).toBeGreaterThan(0);
        expect(issues.join(' | ')).toContain('tools[0]');
    });

    it('formats anthropic tools for responses contract', () => {
        const tools = formatToolsForProvider(
            fixtures.tools.anthropicTools,
            'openai',
            'responses'
        );

        expect(Array.isArray(tools)).toBe(true);
        expect(tools[0]).toMatchObject({
            type: 'function',
            name: 'edit_file'
        });
        expect(tools[0].parameters).toBeTruthy();
    });

    it('normalizes and compacts responses retries with expected shape', () => {
        const messages = fixtures.responses.validBody.messages;

        const normalized = normalizeResponsesMessagesForRetry(messages);
        const compacted = compactResponsesMessagesForRetry(messages);

        expect(Array.isArray(normalized)).toBe(true);
        expect(Array.isArray(compacted)).toBe(true);
        expect(normalized.length).toBe(messages.length);
        expect(compacted.length).toBeGreaterThan(0);

        const compactIssues = validateCloudProxyBody(
            {
                ...fixtures.responses.validBody,
                messages: compacted
            },
            'openai',
            'responses'
        );
        expect(compactIssues).toEqual([]);
    });
});
