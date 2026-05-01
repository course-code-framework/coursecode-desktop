import { describe, it, expect, vi } from 'vitest';

// Mock electron
vi.mock('electron', () => import('../mocks/electron.js'));

const { getNodePath, getNpmPath, getNpxPath, getChildEnv, npmSpawnArgs, getCLISpawnArgs, isLocalMode } = await import('../../main/node-env.js');

describe('node-env (dev mode)', () => {
    // In tests, app.isPackaged is false (dev mode)

    describe('isLocalMode', () => {
        it('returns false when COURSECODE_LOCAL is not set', () => {
            delete process.env.COURSECODE_LOCAL;
            expect(isLocalMode()).toBe(false);
        });

        it('returns true when COURSECODE_LOCAL is set', () => {
            process.env.COURSECODE_LOCAL = '1';
            expect(isLocalMode()).toBe(true);
            delete process.env.COURSECODE_LOCAL;
        });
    });

    describe('getNodePath', () => {
        it('returns process.execPath in dev mode', () => {
            expect(getNodePath()).toBe(process.execPath);
        });
    });

    describe('getNpmPath', () => {
        it('returns the app npm CLI in dev mode when available', () => {
            expect(getNpmPath()).toMatch(/node_modules[\\/]npm[\\/]bin[\\/]npm-cli\.js$/);
        });
    });

    describe('getNpxPath', () => {
        it('returns the app npx CLI in dev mode when available', () => {
            expect(getNpxPath()).toMatch(/node_modules[\\/]npm[\\/]bin[\\/]npx-cli\.js$/);
        });
    });

    describe('getChildEnv', () => {
        it('includes PATH with Node directory prepended', () => {
            const env = getChildEnv();
            expect(env.PATH).toBeDefined();
            expect(env.PATH.length).toBeGreaterThan(0);
        });

        it('merges extra env vars', () => {
            const env = getChildEnv({ MY_VAR: 'test' });
            expect(env.MY_VAR).toBe('test');
        });

        it('extra env vars override process.env', () => {
            process.env.OVERRIDE_TEST = 'original';
            const env = getChildEnv({ OVERRIDE_TEST: 'overridden' });
            expect(env.OVERRIDE_TEST).toBe('overridden');
            delete process.env.OVERRIDE_TEST;
        });
    });

    describe('npmSpawnArgs', () => {
        it('runs the app npm CLI through Node in dev mode', () => {
            const { command, args } = npmSpawnArgs(['install']);
            expect(command).toBe(process.execPath);
            expect(args[0]).toMatch(/node_modules[\\/]npm[\\/]bin[\\/]npm-cli\.js$/);
            expect(args.slice(1)).toEqual(['install']);
        });
    });

    describe('getCLISpawnArgs', () => {
        it('returns the bundled coursecode CLI in dev mode when available', () => {
            const { command, args } = getCLISpawnArgs(['build', '--format', 'cmi5']);
            expect(command).toBe('node');
            expect(args[0]).toMatch(/node_modules[\\/]coursecode[\\/]bin[\\/]cli\.js$/);
            expect(args.slice(1)).toEqual(['build', '--format', 'cmi5']);
        });

        it('returns empty args by default', () => {
            const { command, args } = getCLISpawnArgs();
            expect(command).toBe('node');
            expect(args[0]).toMatch(/node_modules[\\/]coursecode[\\/]bin[\\/]cli\.js$/);
            expect(args.slice(1)).toEqual([]);
        });
    });
});
