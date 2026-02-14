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
        expect(toolIds).toContain('claudeCode');
        expect(toolIds).toContain('vscode');
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

    it('claudeCode has MCP config metadata', () => {
        const cc = registry.tools.claudeCode;
        expect(cc.mcp).toBeTruthy();
        expect(cc.mcp.configDir).toBeTruthy();
        expect(cc.mcp.configFile).toBeTruthy();
        expect(cc.mcp.serverKey).toBeTruthy();
        expect(cc.mcp.entry).toBeTruthy();
        expect(cc.mcp.detectKeys).toBeTruthy();
        expect(Array.isArray(cc.mcp.detectKeys)).toBe(true);
    });

    it('MCP entry has course code command', () => {
        const entry = registry.tools.claudeCode.mcp.entry;
        expect(entry.command).toBe('coursecode');
        expect(entry.args).toContain('mcp');
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
        expect(getToolMeta('claudeCode')).toBeTruthy();
        expect(getToolMeta('vscode')).toBeTruthy();
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
