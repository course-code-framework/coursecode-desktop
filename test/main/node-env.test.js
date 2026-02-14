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
        it('returns "npm" in dev mode', () => {
            expect(getNpmPath()).toBe('npm');
        });
    });

    describe('getNpxPath', () => {
        it('returns "npx" in dev mode', () => {
            expect(getNpxPath()).toBe('npx');
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
        it('returns npm as command in dev mode', () => {
            const { command, args } = npmSpawnArgs(['install']);
            expect(command).toBe('npm');
            expect(args).toEqual(['install']);
        });
    });

    describe('getCLISpawnArgs', () => {
        it('returns coursecode as command in dev mode', () => {
            const { command, args } = getCLISpawnArgs(['build', '--format', 'cmi5']);
            expect(command).toBe('coursecode');
            expect(args).toEqual(['build', '--format', 'cmi5']);
        });

        it('returns empty args by default', () => {
            const { command, args } = getCLISpawnArgs();
            expect(command).toBe('coursecode');
            expect(args).toEqual([]);
        });
    });
});
