import { getSetting } from './settings.js';
import { BASE_PERSONA, COURSE_SPECIFIC_RULES, TOOL_DEFINITIONS } from './ai-config.js';

// --- Assemble full system prompt ---

export function buildSystemPrompt(projectContext = {}, projectMemory = null) {
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

    if (projectMemory?.summary) {
        parts.push(`\n## Course Memory\n${projectMemory.summary}`);
    }
    if (projectMemory?.constraints?.length) {
        parts.push(`\n## Course Constraints\n${projectMemory.constraints.map(c => `- ${c}`).join('\n')}`);
    }
    if (projectMemory?.decisions?.length) {
        parts.push(`\n## Accepted Decisions\n${projectMemory.decisions.map(d => `- ${d}`).join('\n')}`);
    }
    if (projectMemory?.openQuestions?.length) {
        parts.push(`\n## Open Questions\n${projectMemory.openQuestions.map(q => `- ${q}`).join('\n')}`);
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
