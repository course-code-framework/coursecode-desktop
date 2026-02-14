import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { setUserDataDir } from '../mocks/electron.js';

// Make the mock report isPackaged = true for file-logging tests
vi.mock('electron', async () => {
    const mock = await import('../mocks/electron.js');
    return {
        ...mock,
        app: {
            ...mock.app,
            isPackaged: false, // dev mode for console tests
        }
    };
});

const { createLogger } = await import('../../main/logger.js');

describe('createLogger', () => {

    it('returns an object with debug, info, warn, error methods', () => {
        const log = createLogger('test-module');
        expect(typeof log.debug).toBe('function');
        expect(typeof log.info).toBe('function');
        expect(typeof log.warn).toBe('function');
        expect(typeof log.error).toBe('function');
    });

    it('does not throw when logging strings', () => {
        const log = createLogger('test-module');
        expect(() => log.debug('debug message')).not.toThrow();
        expect(() => log.info('info message')).not.toThrow();
        expect(() => log.warn('warn message')).not.toThrow();
        expect(() => log.error('error message')).not.toThrow();
    });

    it('does not throw when logging with extra data', () => {
        const log = createLogger('test-module');
        expect(() => log.info('with data', { port: 3000 })).not.toThrow();
    });

    it('does not throw when logging with Error objects', () => {
        const log = createLogger('test-module');
        const err = new Error('test error');
        expect(() => log.error('failed', err)).not.toThrow();
    });

    it('does not throw with undefined extra', () => {
        const log = createLogger('test-module');
        expect(() => log.info('no extra', undefined)).not.toThrow();
    });

    it('creates independent loggers per module', () => {
        const log1 = createLogger('module-a');
        const log2 = createLogger('module-b');
        // Both should function independently
        expect(() => {
            log1.info('from module a');
            log2.info('from module b');
        }).not.toThrow();
    });
});
