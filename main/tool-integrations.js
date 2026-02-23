import { execSync, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import registry from './tool-registry.json';
import { getCLISpawnArgs } from './node-env.js';

/**
 * Detect installed external tools using the tool registry.
 * Returns { cli, git, githubDesktop }.
 */
export async function detectTools() {
    const results = {};
    for (const [id, tool] of Object.entries(registry.tools)) {
        results[id] = detectTool(id, tool);
    }
    return results;
}

/**
 * Get registry metadata for a tool by ID.
 */
export function getToolMeta(toolId) {
    return registry.tools[toolId] || null;
}

function detectTool(id, tool) {
    const detect = tool.detect;
    if (!detect) return false;

    // In packaged builds, the CLI can be bundled even if not globally installed.
    if (id === 'cli' && checkBundledCLI()) return true;

    // Try command detection first
    if (detect.command && checkCommand(detect.command)) return true;

    // Try platform-specific fallback paths
    const fallbacks = detect.fallbackPaths?.[process.platform];
    if (fallbacks) {
        for (const p of fallbacks) {
            const resolved = p.replace('%LOCALAPPDATA%', process.env.LOCALAPPDATA || '');
            if (existsSync(resolved)) return true;
        }
    }

    return false;
}

function checkBundledCLI() {
    try {
        const { command, args } = getCLISpawnArgs(['--version']);
        const result = spawnSync(command, args, { stdio: 'ignore' });
        return result.status === 0;
    } catch {
        return false;
    }
}

function checkCommand(cmd) {
    try {
        const which = process.platform === 'win32' ? 'where' : 'which';
        execSync(`${which} ${cmd}`, { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}
