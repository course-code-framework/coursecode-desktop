import { getSetting } from './settings.js';
import { BASE_PERSONA, COURSE_SPECIFIC_RULES, TOOL_DEFINITIONS } from './ai-config.js';

// --- Assemble full system prompt ---

export function buildSystemPrompt(projectContext = {}) {
    const parts = [BASE_PERSONA, COURSE_SPECIFIC_RULES];

    // Project context
    if (projectContext.title) {
        parts.push(`\n## Current Project\nTitle: ${projectContext.title}`);
    }
    if (projectContext.slides?.length) {
        const slideList = projectContext.slides.map(s => `- ${s.title} (${s.type})`).join('\n');
        parts.push(`\n## Course Structure\n${slideList}`);
    }
    if (projectContext.refs?.length) {
        const refList = projectContext.refs.map(r => `- ${r}`).join('\n');
        parts.push(`\n## Available Reference Documents\n${refList}`);
    }

    // User custom instructions
    const customInstructions = getSetting('aiCustomInstructions');
    if (customInstructions?.trim()) {
        parts.push(`\n## User Instructions\n${customInstructions.trim()}`);
    }

    return parts.join('\n\n');
}

export function getToolDefinitions() {
    return TOOL_DEFINITIONS;
}
