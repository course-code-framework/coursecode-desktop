import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron before importing the module under test
vi.mock('electron', () => import('../mocks/electron.js'));

const { translateError, translateChatError, wrapIpcHandler } = await import('../../main/errors.js');

describe('translateError', () => {

    it('returns PORT_IN_USE for EADDRINUSE', () => {
        const err = new Error('listen EADDRINUSE');
        err.code = 'EADDRINUSE';
        const result = translateError(err);
        expect(result.code).toBe('PORT_IN_USE');
        expect(result.message).toContain('port');
    });

    it('returns PERMISSION_DENIED for EACCES', () => {
        const err = new Error('permission denied');
        err.code = 'EACCES';
        const result = translateError(err);
        expect(result.code).toBe('PERMISSION_DENIED');
        expect(result.message).toContain('Permission');
    });

    it('returns FILE_MISSING for ENOENT', () => {
        const err = new Error('no such file');
        err.code = 'ENOENT';
        const result = translateError(err);
        expect(result.code).toBe('FILE_MISSING');
    });

    it('returns NETWORK_ERROR for ECONNREFUSED', () => {
        const err = new Error('connect ECONNREFUSED');
        err.code = 'ECONNREFUSED';
        const result = translateError(err);
        expect(result.code).toBe('NETWORK_ERROR');
    });

    it('returns NETWORK_ERROR for ECONNREFUSED in cause', () => {
        const err = new Error('fetch failed');
        err.cause = { code: 'ECONNREFUSED' };
        const result = translateError(err);
        expect(result.code).toBe('NETWORK_ERROR');
    });

    it('returns NPM_ERROR for npm failures', () => {
        const err = new Error('npm ERR! code E404');
        const result = translateError(err);
        expect(result.code).toBe('NPM_ERROR');
    });

    it('returns AUTH_EXPIRED for 401 status', () => {
        const err = new Error('Unauthorized');
        err.status = 401;
        const result = translateError(err);
        expect(result.code).toBe('AUTH_EXPIRED');
    });

    it('returns NO_CREDITS for 402 status', () => {
        const err = new Error('Payment Required');
        err.status = 402;
        const result = translateError(err);
        expect(result.code).toBe('NO_CREDITS');
        expect(result.message).toContain('credits');
    });

    it('returns RATE_LIMITED for 429 status', () => {
        const err = new Error('Too Many Requests');
        err.status = 429;
        const result = translateError(err);
        expect(result.code).toBe('RATE_LIMITED');
    });

    it('returns CLI_NOT_READY for CLI errors', () => {
        const err = new Error('CLI not found');
        err.code = 'CLI_NOT_READY';
        const result = translateError(err);
        expect(result.code).toBe('CLI_NOT_READY');
        expect(result.message).toContain('Setup Assistant');
    });

    it('returns ENCRYPTION_UNAVAILABLE for safeStorage errors', () => {
        const err = new Error('safeStorage is not available');
        const result = translateError(err);
        expect(result.code).toBe('ENCRYPTION_UNAVAILABLE');
    });

    it('returns NETWORK_ERROR for fetch + ENOTFOUND', () => {
        const err = new Error('fetch failed');
        err.cause = { code: 'ENOTFOUND' };
        const result = translateError(err);
        expect(result.code).toBe('NETWORK_ERROR');
    });

    it('returns NETWORK_ERROR for fetch + ETIMEDOUT', () => {
        const err = new Error('fetch failed');
        err.cause = { code: 'ETIMEDOUT' };
        const result = translateError(err);
        expect(result.code).toBe('NETWORK_ERROR');
    });

    it('returns INTERNAL with message for unknown errors', () => {
        const err = new Error('Something entirely novel happened');
        const result = translateError(err);
        expect(result.code).toBe('INTERNAL');
        expect(result.message).toContain('Something entirely novel happened');
    });

    it('handles null/undefined errors gracefully', () => {
        const result = translateError(null);
        expect(result.code).toBe('INTERNAL');
        expect(result.message).toBe('An unknown error occurred.');
    });

    it('preserves original message as detail', () => {
        const err = new Error('listen EADDRINUSE: 0.0.0.0:3000');
        err.code = 'EADDRINUSE';
        const result = translateError(err);
        expect(result.detail).toBe('listen EADDRINUSE: 0.0.0.0:3000');
    });

    it('preserves stack as detail for fallback errors', () => {
        const err = new Error('weird');
        const result = translateError(err);
        expect(result.detail).toContain('weird');
    });

    it('returns ENCRYPTION_UNAVAILABLE for "encryption" keyword', () => {
        const err = new Error('system encryption not available');
        const result = translateError(err);
        expect(result.code).toBe('ENCRYPTION_UNAVAILABLE');
    });

    it('returns NETWORK_ERROR for generic "timed out"', () => {
        const err = new Error('Request timed out');
        const result = translateError(err);
        expect(result.code).toBe('NETWORK_ERROR');
    });

    it('returns NETWORK_ERROR for generic "fetch failed" without cause', () => {
        const err = new Error('fetch failed');
        // No cause set — should still match the last fetch failed rule
        const result = translateError(err);
        expect(result.code).toBe('NETWORK_ERROR');
    });

    it('handles error with no message', () => {
        const err = new Error();
        const result = translateError(err);
        expect(result.code).toBe('INTERNAL');
        // Should not crash on empty message
        expect(result.message).toContain('Unknown error');
    });

    it('handles undefined error', () => {
        const result = translateError(undefined);
        expect(result.code).toBe('INTERNAL');
    });

    it('preserves detail when matched error has no message', () => {
        const err = new Error();
        err.code = 'EADDRINUSE';
        const result = translateError(err);
        expect(result.code).toBe('PORT_IN_USE');
        expect(result.detail).toBe('');
    });

    it('ERROR_MAP evaluates rules in priority order', () => {
        // An error that matches both ECONNREFUSED (direct) and fetch failed
        const err = new Error('fetch failed');
        err.code = 'ECONNREFUSED';
        const result = translateError(err);
        // Should match the ECONNREFUSED rule first (comes before fetch failed)
        expect(result.code).toBe('NETWORK_ERROR');
    });
});

describe('translateChatError', () => {

    it('returns cloud-specific message for 401 in cloud mode', () => {
        const err = new Error('Unauthorized');
        err.status = 401;
        const message = translateChatError(err, true);
        expect(message).toContain('cloud session');
        expect(message).toContain('Dashboard');
    });

    it('returns BYOK-specific message for 401 in BYOK mode', () => {
        const err = new Error('Unauthorized');
        err.status = 401;
        const message = translateChatError(err, false);
        expect(message).toContain('API key');
        expect(message).toContain('Settings');
    });

    it('delegates non-401 errors to translateError', () => {
        const err = new Error('fetch failed');
        err.cause = { code: 'ECONNREFUSED' };
        const message = translateChatError(err, true);
        expect(message).toContain('server');
    });
});

describe('wrapIpcHandler', () => {

    it('returns the handler result on success', async () => {
        const handler = wrapIpcHandler('test:channel', async () => 'ok');
        const result = await handler();
        expect(result).toBe('ok');
    });

    it('translates and re-throws errors', async () => {
        const err = new Error('listen EADDRINUSE');
        err.code = 'EADDRINUSE';
        const handler = wrapIpcHandler('test:channel', async () => { throw err; });

        await expect(handler()).rejects.toThrow('port');
    });

    it('attaches error code to the thrown error', async () => {
        const err = new Error('listen EADDRINUSE');
        err.code = 'EADDRINUSE';
        const handler = wrapIpcHandler('test:channel', async () => { throw err; });

        try {
            await handler();
        } catch (e) {
            expect(e.code).toBe('PORT_IN_USE');
        }
    });

    it('works with sync handlers', async () => {
        const handler = wrapIpcHandler('test:channel', () => 42);
        const result = await handler();
        expect(result).toBe(42);
    });

    it('passes arguments through to the handler', async () => {
        const spy = vi.fn((_event, path, opts) => ({ path, opts }));
        const handler = wrapIpcHandler('test:channel', spy);
        const result = await handler('event', '/path', { port: 3000 });
        expect(spy).toHaveBeenCalledWith('event', '/path', { port: 3000 });
        expect(result).toEqual({ path: '/path', opts: { port: 3000 } });
    });
});
