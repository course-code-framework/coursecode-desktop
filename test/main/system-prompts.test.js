import { describe, it, expect, vi } from 'vitest';

// Mock electron
vi.mock('electron', () => import('../mocks/electron.js'));

// Mock settings
vi.mock('../../main/settings.js', () => ({
    getSetting: vi.fn((key) => {
        if (key === 'aiCustomInstructions') return '';
        return null;
    }),
}));

const { buildSystemPrompt } = await import('../../main/system-prompts.js');
const { FILE_TOOL_DEFINITIONS, TOOL_LABELS, PREVIEW_TOOLS, BASE_PERSONA } = await import('../../main/ai-config.js');
const settingsMock = await import('../../main/settings.js');

describe('buildSystemPrompt', () => {

    it('always includes base persona', () => {
        const prompt = buildSystemPrompt();
        expect(prompt).toContain('CourseCode course designer');
        expect(prompt).toContain('execution-first');
    });

    it('always includes course-specific rules', () => {
        const prompt = buildSystemPrompt();
        expect(prompt).toContain('COURSE-SPECIFIC OPTIMIZATION');
    });

    it('includes project title when provided', () => {
        const prompt = buildSystemPrompt({ title: 'Safety Training 101' });
        expect(prompt).toContain('Safety Training 101');
        expect(prompt).toContain('## Current Project');
    });

    it('omits project section when no title', () => {
        const prompt = buildSystemPrompt({});
        expect(prompt).not.toContain('## Current Project');
    });

    it('includes slide list when slides are provided', () => {
        const prompt = buildSystemPrompt({
            slides: [
                { id: 'welcome', title: 'Welcome', type: 'content' },
                { id: 'quiz-1', title: 'Quiz', type: 'assessment' }
            ]
        });
        expect(prompt).toContain('## Course Structure');
        expect(prompt).toContain('- welcome: Welcome');
        expect(prompt).toContain('slides/welcome.js');
        expect(prompt).toContain('- quiz-1: Quiz');
        expect(prompt).toContain('slides/quiz-1.js');
    });

    it('omits slide list when slides array is empty', () => {
        const prompt = buildSystemPrompt({ slides: [] });
        expect(prompt).not.toContain('## Course Structure');
    });

    it('includes reference documents', () => {
        const prompt = buildSystemPrompt({ refs: ['safety-manual.md', 'regulations.md'] });
        expect(prompt).toContain('## Available Reference Documents');
        expect(prompt).toContain('- safety-manual.md');
    });

    it('includes workflow context when provided as a string', () => {
        const prompt = buildSystemPrompt({}, 'Preview is running and ready for runtime tools.');
        expect(prompt).toContain('## Framework Workflow Context');
        expect(prompt).toContain('Preview is running and ready for runtime tools.');
    });

    it('ignores non-string workflow context values', () => {
        const prompt = buildSystemPrompt({}, { summary: 'legacy shape' });
        expect(prompt).not.toContain('## Framework Workflow Context');
        expect(prompt).not.toContain('legacy shape');
    });

    it('includes custom instructions from settings', () => {
        settingsMock.getSetting.mockReturnValue('Always use formal language.');
        const prompt = buildSystemPrompt();
        expect(prompt).toContain('## User Instructions');
        expect(prompt).toContain('Always use formal language.');
    });

    it('omits custom instructions section when empty', () => {
        settingsMock.getSetting.mockReturnValue('');
        const prompt = buildSystemPrompt();
        expect(prompt).not.toContain('## User Instructions');
    });

    it('omits custom instructions section when whitespace-only', () => {
        settingsMock.getSetting.mockReturnValue('   \n  \n  ');
        const prompt = buildSystemPrompt();
        expect(prompt).not.toContain('## User Instructions');
    });

    it('builds full prompt with all context', () => {
        settingsMock.getSetting.mockReturnValue('Keep it concise.');
        const prompt = buildSystemPrompt(
            {
                title: 'Intro to Safety',
                slides: [{ id: 'welcome', title: 'Welcome', type: 'content' }],
                refs: ['manual.md']
            },
            'Preview is running and the active slide is welcome.'
        );
        // All sections should be present
        expect(prompt).toContain('CourseCode course designer');
        expect(prompt).toContain('Intro to Safety');
        expect(prompt).toContain('welcome: Welcome');
        expect(prompt).toContain('manual.md');
        expect(prompt).toContain('Preview is running and the active slide is welcome.');
        expect(prompt).toContain('Keep it concise.');
    });
});

describe('FILE_TOOL_DEFINITIONS', () => {

    it('contains only file I/O tools', () => {
        const names = FILE_TOOL_DEFINITIONS.map(t => t.name);
        expect(names).toContain('read_file');
        expect(names).toContain('edit_file');
        expect(names).toContain('create_file');
        expect(names).toContain('list_files');
        expect(names).toContain('search_files');
        expect(names.length).toBe(5);
    });
});

describe('ai-config consistency', () => {

    it('every file tool definition has name, description, and input_schema', () => {
        for (const tool of FILE_TOOL_DEFINITIONS) {
            expect(tool.name, `tool missing name`).toBeTruthy();
            expect(tool.description, `${tool.name} missing description`).toBeTruthy();
            expect(tool.input_schema, `${tool.name} missing input_schema`).toBeTruthy();
            expect(tool.input_schema.type, `${tool.name} schema type should be object`).toBe('object');
        }
    });

    it('every file tool has a label in TOOL_LABELS', () => {
        for (const tool of FILE_TOOL_DEFINITIONS) {
            expect(TOOL_LABELS[tool.name], `${tool.name} has no label in TOOL_LABELS`).toBeTruthy();
        }
    });

    it('coursecode_* tools in TOOL_LABELS are not in FILE_TOOL_DEFINITIONS', () => {
        const fileToolNames = new Set(FILE_TOOL_DEFINITIONS.map(t => t.name));
        for (const labelName of Object.keys(TOOL_LABELS)) {
            if (labelName.startsWith('coursecode_')) {
                expect(fileToolNames.has(labelName), `${labelName} should not be in FILE_TOOL_DEFINITIONS`).toBe(false);
            }
        }
    });

    it('required fields are actually array type', () => {
        for (const tool of FILE_TOOL_DEFINITIONS) {
            if (tool.input_schema.required) {
                expect(Array.isArray(tool.input_schema.required),
                    `${tool.name}: required should be array`).toBe(true);
                for (const req of tool.input_schema.required) {
                    expect(tool.input_schema.properties?.[req],
                        `${tool.name}: required field "${req}" not in properties`).toBeDefined();
                }
            }
        }
    });
});
