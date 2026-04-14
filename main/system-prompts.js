import { getSetting } from './settings.js';
import { BASE_PERSONA, COURSE_SPECIFIC_RULES, FRAMEWORK_ESSENTIALS } from './ai-config.js';

// --- Assemble full system prompt ---

export function buildSystemPrompt(projectContext = {}, mcpInstructions = null) {
    const parts = [BASE_PERSONA, COURSE_SPECIFIC_RULES, FRAMEWORK_ESSENTIALS];

    // Project context
    if (projectContext.title) {
        parts.push(`\n## Current Project\nTitle: ${projectContext.title}`);
    }
    if (projectContext.slides?.length) {
        const slideList = projectContext.slides.map(s => `- ${s.id}: ${s.title} → slides/${s.id}.js`).join('\n');
        parts.push(`\n## Course Structure (slide ID → file path)\n${slideList}`);
    }
    if (projectContext.activeSlide) {
        parts.push(`\n## Active Slide (currently visible in preview)\nID: ${projectContext.activeSlide.id} → ${projectContext.activeSlide.file}`);
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

    // MCP server stage-aware instructions (when preview is running)
    if (mcpInstructions?.trim()) {
        parts.push(`\n## Framework Workflow Context\n${mcpInstructions.trim()}`);
    }

    return parts.join('\n\n');
}
