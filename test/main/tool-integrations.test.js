import { describe, it, expect, vi } from 'vitest';

// Mock electron
vi.mock('electron', () => import('../mocks/electron.js'));

// Mock node-env
vi.mock('../../main/node-env.js', () => ({
    getCLISpawnArgs: vi.fn((args) => ({ command: 'echo', args })),
}));

const { getToolMeta } = await import('../../main/tool-integrations.js');
const registry = (await import('../../main/tool-registry.json')).default;

describe('tool-registry.json', () => {

    it('has all expected tools', () => {
        const toolIds = Object.keys(registry.tools);
        expect(toolIds).toContain('cli');
        expect(toolIds).toContain('git');
        expect(toolIds).toContain('githubDesktop');
    });

    it('every tool has a name and description', () => {
        for (const [id, tool] of Object.entries(registry.tools)) {
            expect(tool.name, `${id} missing name`).toBeTruthy();
            expect(tool.description, `${id} missing description`).toBeTruthy();
        }
    });

    it('every tool with a downloadUrl has a valid URL', () => {
        for (const [id, tool] of Object.entries(registry.tools)) {
            if (tool.downloadUrl) {
                expect(tool.downloadUrl, `${id} has invalid URL`).toMatch(/^https?:\/\//);
            }
        }
    });



    it('cli tool has install configuration', () => {
        const cli = registry.tools.cli;
        expect(cli.install).toBeTruthy();
        expect(cli.install.npmPackage).toBe('coursecode');
        expect(cli.install.versionFlag).toBe('--version');
    });

    it('every tool has either command detection or fallback paths', () => {
        for (const [id, tool] of Object.entries(registry.tools)) {
            if (!tool.detect) continue;
            const hasCommand = !!tool.detect.command;
            const hasFallbacks = !!tool.detect.fallbackPaths;
            expect(hasCommand || hasFallbacks,
                `${id} has detect but no command or fallbackPaths`).toBe(true);
        }
    });
});

describe('getToolMeta', () => {

    it('returns metadata for known tools', () => {
        expect(getToolMeta('cli')).toBeTruthy();
        expect(getToolMeta('git')).toBeTruthy();
        expect(getToolMeta('githubDesktop')).toBeTruthy();
    });

    it('returns null for unknown tools', () => {
        expect(getToolMeta('nonexistent')).toBeNull();
    });

    it('returns the full tool object', () => {
        const meta = getToolMeta('cli');
        expect(meta.name).toBe('CourseCode Tools');
        expect(meta.detect).toBeTruthy();
    });
});
