/**
 * ai-config.js — Centralized AI configuration
 *
 * All frequently-tuned AI settings live here:
 * prompts, model defaults, token limits, tool definitions, and tuning knobs.
 */

// ---------------------------------------------------------------------------
// System Prompt
// ---------------------------------------------------------------------------

export const BASE_PERSONA = `You are an expert CourseCode course designer and autonomous authoring agent built into the CourseCode Desktop app. You create, modify, and debug interactive e-learning courses by operating directly on course files through your tools.

You act, then report. When the user asks you to do something, use your tools immediately to accomplish it. Gather context with read tools, make changes with edit tools, and verify results visually. Do not describe what you plan to do or ask for permission to start unless the request is genuinely ambiguous.

COMMUNICATION RULES:
- Use simple, non-technical language. The user is an instructional designer, not a developer.
- Never show source code, file paths, diffs, or raw tool output to the user.
- After making changes, take a screenshot and describe what changed visually.
- Never claim a file was changed unless edit_file or create_file succeeded in this turn.
- When something fails, explain briefly what happened and try a different approach.
- Reference slides by their title, never by ID or filename.

TOOL USE:
1. Read before writing. Always read a file before editing it.
2. Use search_files to locate specific text, then read_file with start_line/end_line around those line numbers to get context.
3. Use coursecode_state to understand the current course structure.
4. Use edit_file for targeted changes. Use create_file only for new files.
5. After edits, take a screenshot to verify the result.
6. Run coursecode_lint to catch issues after changes. It checks both static structure and live runtime errors.
7. If lint reports problems, fix them before responding to the user.

FILE PATHS:
All paths are relative to the course directory root. The course directory IS the root.
- Slides: slides/<slideId>.js (e.g. slides/intro.js, slides/module-1-overview.js)
- Config: course-config.js
- Assessments: assessments/<name>.js
- Assets: assets/<filename>
- There is NO src/ prefix. Never prepend src/, course/, or any other prefix.
- When a tool reports "File not found", check the hint in the error or call list_files.

EDITING:
- edit_file replaces one exact match. old_string must match the file content character-for-character including whitespace.
- Include 2-3 surrounding lines in old_string so it matches exactly one location.
- Make small, focused edits. Multiple small edit_file calls are better than one large replacement.
- Never recreate an entire file with create_file when you could edit_file a few lines.`;

export const COURSE_SPECIFIC_RULES = `COURSE-SPECIFIC OPTIMIZATION:
- You are an instructional design expert, not a generic coding assistant.
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

// ---------------------------------------------------------------------------
// Tool Definitions — File I/O only (sent to the LLM)
//
// coursecode_* tools are discovered at runtime from the MCP server.
// Only file tools are defined here because they execute locally in the
// main process and are always available (no preview server required).
// Paths are relative to the course directory (e.g. slides/intro.js).
// ---------------------------------------------------------------------------

export const FILE_TOOL_DEFINITIONS = [
    {
        name: 'read_file',
        description: 'Read a file in the course project. All paths are relative to the course directory root (e.g. slides/intro.js, course-config.js, assets/logo.png). There is no src/ prefix. If the file is not found, the error will suggest the correct path or recommend using list_files to discover it. Returns totalLines so you can request additional ranges if the file was truncated.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path relative to the course directory. Examples: slides/intro.js, slides/module-1-overview.js, course-config.js, assessments/quiz-1.js. Never prefix with src/ or course/.' },
                start_line: { type: 'integer', description: 'First line to read (1-based, inclusive). Omit to start from the beginning.' },
                end_line: { type: 'integer', description: 'Last line to read (1-based, inclusive). Omit to read to the end. Use with start_line to read a specific range of a large file.' }
            },
            required: ['path']
        }
    },
    {
        name: 'edit_file',
        description: 'Replace an exact string in an existing course file. old_string must match exactly one location in the file, character-for-character including whitespace and indentation. Include 2-3 surrounding context lines so the match is unique. If old_string matches zero times, you probably have a whitespace or content mismatch; read the file first to see the current content. If it matches more than once, include more surrounding lines.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path relative to the course directory (e.g. slides/intro.js). Never prefix with src/ or course/.' },
                old_string: { type: 'string', description: 'The exact text to find. Must match exactly once. Include 2-3 surrounding lines for a unique match.' },
                new_string: { type: 'string', description: 'The replacement text. Use empty string to delete the matched text.' }
            },
            required: ['path', 'old_string', 'new_string']
        }
    },
    {
        name: 'create_file',
        description: 'Create a new file in the course project. Fails if the file already exists; use edit_file to modify existing files. Parent directories are created automatically.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path relative to the course directory (e.g. slides/new-slide.js). Never prefix with src/ or course/.' },
                content: { type: 'string', description: 'The full content to write to the new file.' }
            },
            required: ['path', 'content']
        }
    },
    {
        name: 'search_files',
        description: 'Search for text across course project files. Returns matching lines with line numbers and file paths. Use this to locate code before editing: find the line numbers, then use read_file with start_line/end_line to get surrounding context. Searches all text files under the course directory recursively.',
        input_schema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Text or regex pattern to search for. Case-insensitive. Examples: "callout-compact", "export default", "TODO".' },
                path: { type: 'string', description: 'Optional. Limit search to a specific file or directory relative to the course root. Examples: "slides/intro.js", "slides". Omit to search all files.' },
                is_regex: { type: 'boolean', description: 'If true, treat pattern as a regular expression. Default: false (literal string match).' }
            },
            required: ['pattern']
        }
    },
    {
        name: 'list_files',
        description: 'List files and subdirectories in the course project. Use this to discover file paths before reading or editing. Returns file names, type (file/directory), and line counts for text files so you can plan read_file ranges.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Directory path relative to the course directory. Omit or use "." for the course root. Use "slides" to list all slide files.' }
            }
        }
    }
];

// Legacy alias — use FILE_TOOL_DEFINITIONS for file-only, getToolDefinitions() never
// called directly anymore; runtimeTools is assembled in chat-engine.js.
export const TOOL_DEFINITIONS = FILE_TOOL_DEFINITIONS;

// ---------------------------------------------------------------------------
// Tool Display Labels (shown in the chat UI)
// ---------------------------------------------------------------------------

export const TOOL_LABELS = {
    edit_file: 'Making changes…',
    create_file: 'Creating file…',
    read_file: 'Reading file…',
    search_files: 'Searching files…',
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
    coursecode_icon_catalog: 'Looking up icons…',
    coursecode_viewport: 'Resizing viewport…',
    coursecode_export_content: 'Exporting content…'
};

// ---------------------------------------------------------------------------
// Tools that require the preview server to be running
// ---------------------------------------------------------------------------

export const PREVIEW_TOOLS = new Set([
    'coursecode_state', 'coursecode_navigate', 'coursecode_screenshot',
    'coursecode_interact', 'coursecode_reset', 'coursecode_viewport'
]);

// ---------------------------------------------------------------------------
// Tool Execution Classification
// ---------------------------------------------------------------------------

/** Tools that are safe to run without user approval (read-only) */
export const SAFE_TOOLS = new Set([
    'read_file', 'list_files', 'search_files',
    'coursecode_state', 'coursecode_navigate', 'coursecode_screenshot',
    'coursecode_lint', 'coursecode_component_catalog', 'coursecode_css_catalog',
    'coursecode_interaction_catalog', 'coursecode_icon_catalog',
    'coursecode_workflow_status', 'coursecode_viewport', 'coursecode_export_content'
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
    'coursecode_workflow_status', 'coursecode_viewport', 'coursecode_export_content'
]);

// ---------------------------------------------------------------------------
// History & Token Management
// ---------------------------------------------------------------------------

/** Max size (chars) for a single tool result before truncation */
export const TOOL_RESULT_MAX_CHARS = 16_000;

/** Truncation notice appended when a tool result is trimmed */
export const TOOL_RESULT_TRUNCATION_NOTE = '… (truncated — use read_file with start_line/end_line to read remaining lines)';

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
