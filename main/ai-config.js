/**
 * ai-config.js — Centralized AI configuration
 *
 * All frequently-tuned AI settings live here:
 * prompts, model defaults, token limits, tool definitions, and tuning knobs.
 */

// ---------------------------------------------------------------------------
// System Prompt
// ---------------------------------------------------------------------------

export const BASE_PERSONA = `You are a CourseCode course designer assistant built into the CourseCode Desktop app.
You help instructional designers create interactive e-learning courses.

CRITICAL RULES:
- Never show source code, file paths, diffs, or technical details to the user.
- After making changes, always take a screenshot and describe what changed visually.
- Never claim a file was changed unless edit_file/create_file succeeded in this turn.
- Use simple, non-technical language in all responses.
- When something goes wrong, explain what happened and what you're trying instead.
- Ask clarifying questions when the user's request is ambiguous.
- Reference slides by their title, never by ID or filename.

PREFERRED WORKFLOW:
1. Use coursecode_state first to understand the current course structure.
2. Read files before editing to understand existing content.
3. Use edit_file to make targeted changes (preferred) or create_file for new files.
4. Take a screenshot to verify the result and describe what changed.
5. Run coursecode_lint to catch any issues.
6. Fix issues before moving on.

FILE EDITING RULES:
- Always use edit_file for modifying existing files. Never rewrite an entire file to change a few lines.
- The old_string must match the file content exactly, including whitespace and indentation.
- Include enough context lines in old_string to uniquely identify the target location.
- Keep edits minimal and focused. Make multiple small edit_file calls rather than one large replacement.
- Use create_file only when adding a brand-new file that does not exist yet.`;

export const COURSE_SPECIFIC_RULES = `COURSE-SPECIFIC OPTIMIZATION:
- Treat this as an instructional design assistant, not a generic coding assistant.
- Prioritize learning objectives, audience fit, cognitive load, and assessment alignment.
- Keep slide-to-slide continuity explicit (narrative progression and reinforcement).
- Preserve LMS compatibility and accessibility constraints when editing content.`;

// ---------------------------------------------------------------------------
// Model & Provider Defaults
// ---------------------------------------------------------------------------

export const MAX_TOKENS = 8192;
export const DEFAULT_MAX_CONTEXT_CHARS = 120000;
export const OLDER_MESSAGE_MAX_CHARS = 1500;

// ---------------------------------------------------------------------------
// Model Context Windows (tokens) — used for dynamic context budgeting
// ---------------------------------------------------------------------------

export const MODEL_CONTEXT_WINDOWS = {
    // Anthropic
    'claude-3-5-sonnet-latest': 200000,
    'claude-3-7-sonnet-latest': 200000,
    'claude-sonnet-4-20250514': 200000,
    'claude-4-sonnet': 200000,
    // OpenAI
    'gpt-4o': 128000,
    'gpt-4o-mini': 128000,
    'o3': 200000,
    'o3-mini': 128000,
    'o4-mini': 128000,
    // Google
    'gemini-2.5-pro': 1048576,
    'gemini-2.5-flash': 1048576,
};

/** Approximate chars-per-token ratio for context budgeting */
const CHARS_PER_TOKEN = 4;

/**
 * Get the max context chars for a given model, using 75% of the model's
 * context window to leave room for output tokens and system overhead.
 */
export function getMaxContextChars(modelId) {
    const contextTokens = MODEL_CONTEXT_WINDOWS[modelId];
    if (!contextTokens) return DEFAULT_MAX_CONTEXT_CHARS;
    // Use 75% of context window, capped at a reasonable limit
    const budgetTokens = Math.floor(contextTokens * 0.75);
    return Math.min(budgetTokens * CHARS_PER_TOKEN, 600000);
}

// ---------------------------------------------------------------------------
// Cost Warning Thresholds
// ---------------------------------------------------------------------------

/** BYOK cost thresholds (USD) — warn user when session cost exceeds these */
export const COST_WARNING_THRESHOLDS = [2, 5, 10, 25];

/** Cloud credit warning threshold — warn when balance drops below this */
export const CREDIT_LOW_THRESHOLD = 50;

export const DEFAULT_PROVIDER = 'anthropic';
export const DEFAULT_MODEL = null;
export const DEFAULT_CLOUD_MODEL = null;
export const FALLBACK_MODELS = {
    anthropic: 'claude-3-5-sonnet-latest',
    openai: 'gpt-4o',
    google: 'gemini-2.5-pro'
};

// ---------------------------------------------------------------------------
// Tool Definitions (sent to the LLM)
// ---------------------------------------------------------------------------

export const TOOL_DEFINITIONS = [
    {
        name: 'read_file',
        description: 'Read the contents of a file in the course project.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path relative to the project root' }
            },
            required: ['path']
        }
    },
    {
        name: 'edit_file',
        description: 'Make a targeted edit to an existing file by replacing a specific string. The old_string must match exactly one location in the file. Include surrounding lines for context to ensure a unique match.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path relative to the project root' },
                old_string: { type: 'string', description: 'The exact text to find in the file (must match exactly once). Include a few surrounding lines for uniqueness.' },
                new_string: { type: 'string', description: 'The replacement text. Use an empty string to delete the matched text.' }
            },
            required: ['path', 'old_string', 'new_string']
        }
    },
    {
        name: 'create_file',
        description: 'Create a new file in the course project. Fails if the file already exists. Use edit_file to modify existing files.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path relative to the project root' },
                content: { type: 'string', description: 'Full file content to write' }
            },
            required: ['path', 'content']
        }
    },
    {
        name: 'list_files',
        description: 'List files and directories in a path within the course project.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Directory path relative to project root. Use "." for root.' }
            },
            required: ['path']
        }
    },
    {
        name: 'coursecode_state',
        description: 'Get the current course state including structure, slide list, and any errors.',
        input_schema: { type: 'object', properties: {} }
    },
    {
        name: 'coursecode_navigate',
        description: 'Navigate to a specific slide by its ID.',
        input_schema: {
            type: 'object',
            properties: {
                slideId: { type: 'string', description: 'The slide ID to navigate to' }
            },
            required: ['slideId']
        }
    },
    {
        name: 'coursecode_screenshot',
        description: 'Take a screenshot of the current course preview.',
        input_schema: {
            type: 'object',
            properties: {
                slideId: { type: 'string', description: 'Optional slide ID to navigate to before taking the screenshot' },
                detailed: { type: 'boolean', description: 'Use higher resolution for close inspection' }
            }
        }
    },
    {
        name: 'coursecode_lint',
        description: 'Run the course linter to check for structural errors and warnings.',
        input_schema: { type: 'object', properties: {} }
    },
    {
        name: 'coursecode_component_catalog',
        description: 'Get available UI component information. Without type: returns all. With type: returns full schema and usage.',
        input_schema: {
            type: 'object',
            properties: {
                type: { type: 'string', description: 'Optional component type to get full details for' }
            }
        }
    },
    {
        name: 'coursecode_css_catalog',
        description: 'Get available CSS classes. Without category: returns all. With category: returns full detail.',
        input_schema: {
            type: 'object',
            properties: {
                category: { type: 'string', description: 'Optional category for full details' }
            }
        }
    },
    {
        name: 'coursecode_interaction_catalog',
        description: 'Get available interaction types for assessments and quizzes.',
        input_schema: {
            type: 'object',
            properties: {
                type: { type: 'string', description: 'Optional interaction type for full details' }
            }
        }
    },
    {
        name: 'coursecode_interact',
        description: 'Submit a response to an interaction to test it.',
        input_schema: {
            type: 'object',
            properties: {
                interactionId: { type: 'string', description: 'The interaction ID to answer' },
                response: { description: 'The response value' }
            },
            required: ['interactionId', 'response']
        }
    },
    {
        name: 'coursecode_reset',
        description: 'Clear learner state and restart the course from scratch.',
        input_schema: { type: 'object', properties: {} }
    },
    {
        name: 'coursecode_build',
        description: 'Build the course for LMS deployment.',
        input_schema: {
            type: 'object',
            properties: {
                format: { type: 'string', enum: ['cmi5', 'scorm2004', 'scorm1.2', 'lti'], description: 'LMS format' }
            }
        }
    },
    {
        name: 'coursecode_workflow_status',
        description: 'Detect the current authoring stage and get stage-specific instructions.',
        input_schema: { type: 'object', properties: {} }
    },
    {
        name: 'coursecode_icon_catalog',
        description: 'Get available icon names and usage examples.',
        input_schema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Optional icon name for full details' }
            }
        }
    }
];

// ---------------------------------------------------------------------------
// Tool Display Labels (shown in the chat UI)
// ---------------------------------------------------------------------------

export const TOOL_LABELS = {
    edit_file: 'Making changes…',
    create_file: 'Creating file…',
    read_file: 'Reading file…',
    list_files: 'Browsing files…',
    coursecode_screenshot: 'Looking at the result…',
    coursecode_lint: 'Checking for errors…',
    coursecode_navigate: 'Going to slide…',
    coursecode_state: 'Reviewing the course…',
    coursecode_component_catalog: 'Looking up components…',
    coursecode_css_catalog: 'Looking up styles…',
    coursecode_interaction_catalog: 'Looking up interactions…',
    coursecode_interact: 'Testing the interaction…',
    coursecode_reset: 'Resetting the course…',
    coursecode_build: 'Building the course…',
    coursecode_workflow_status: 'Checking progress…',
    coursecode_icon_catalog: 'Looking up icons…'
};

// ---------------------------------------------------------------------------
// Tools that require the preview server to be running
// ---------------------------------------------------------------------------

export const PREVIEW_TOOLS = new Set([
    'coursecode_state', 'coursecode_navigate', 'coursecode_screenshot',
    'coursecode_interact', 'coursecode_reset'
]);

// ---------------------------------------------------------------------------
// Tool Execution Classification
// ---------------------------------------------------------------------------

/** Tools that are safe to run without user approval (read-only) */
export const SAFE_TOOLS = new Set([
    'read_file', 'list_files',
    'coursecode_state', 'coursecode_navigate', 'coursecode_screenshot',
    'coursecode_lint', 'coursecode_component_catalog', 'coursecode_css_catalog',
    'coursecode_interaction_catalog', 'coursecode_icon_catalog',
    'coursecode_workflow_status'
]);

/** Tools that mutate files or course state — may require approval */
export const MUTATION_TOOLS = new Set([
    'edit_file', 'create_file',
    'coursecode_interact', 'coursecode_reset', 'coursecode_build'
]);

/** Tools that can run in parallel (no side effects, independent reads) */
export const PARALLELIZABLE_TOOLS = new Set([
    'read_file', 'list_files',
    'coursecode_state', 'coursecode_screenshot',
    'coursecode_lint', 'coursecode_component_catalog', 'coursecode_css_catalog',
    'coursecode_interaction_catalog', 'coursecode_icon_catalog',
    'coursecode_workflow_status'
]);

// ---------------------------------------------------------------------------
// History & Token Management
// ---------------------------------------------------------------------------

/** Max size (chars) for a single tool result before truncation */
export const TOOL_RESULT_MAX_CHARS = 4000;

/** Truncation notice appended when a tool result is trimmed */
export const TOOL_RESULT_TRUNCATION_NOTE = '… (truncated — use tool again for full output)';

// ---------------------------------------------------------------------------
// Guided Workflow Configurations
// ---------------------------------------------------------------------------

export const WORKFLOW_CONFIGS = {
    'build-outline': {
        label: 'Build Course Outline',
        systemPrompt: `You are an expert instructional designer creating a course outline.

Your task: Analyze the provided reference documents and create a structured course outline using the template provided.

RULES:
- Follow the outline template structure exactly.
- Use the outline guide for best practices on writing effective outlines.
- Ground ALL content in the reference documents — do not invent information.
- Each slide section should include: title, learning objectives, key content points, suggested interactions, and narration notes.
- Use ## headings for each slide/section in the outline.
- Write the complete outline as a single markdown document.
- Be specific about what content goes on each slide — the outline must be detailed enough that someone building slides from it can work on each slide independently.`,
        frameworkDocs: ['COURSE_OUTLINE_TEMPLATE.md', 'COURSE_OUTLINE_GUIDE.md'],
        includeRefs: true
    },
    'build-course': {
        label: 'Build Course from Outline',
        systemPrompt: `You are a CourseCode slide builder. You create individual slide modules from outline specifications.

Your task: Build the slide module described in the slide specification. Use the Course Authoring Guide for component syntax, interaction patterns, and file structure.

RULES:
- Output ONLY the complete JavaScript module code for this slide.
- Follow the patterns and syntax in the Course Authoring Guide exactly.
- Use the components, interactions, and CSS classes documented in the guide.
- Include all content, interactions, and narration specified in the slide spec.
- Do not add content beyond what the outline specifies.
- The module should be a complete, functional slide file.`,
        frameworkDocs: ['COURSE_AUTHORING_GUIDE.md'],
        perSlide: true
    }
};
