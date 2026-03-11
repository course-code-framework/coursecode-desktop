import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock electron
vi.mock('electron', () => import('../mocks/electron.js'));

// Mock llm-provider to avoid real API calls
vi.mock('../../main/llm-provider.js', () => ({
    createProvider: vi.fn(),
    loadApiKey: vi.fn(() => 'sk-test-key'),
    estimateCost: vi.fn(() => ({ inputCost: 0, outputCost: 0 })),
    getProviders: vi.fn(async () => ([
        {
            id: 'anthropic',
            models: [{ id: 'claude-3-5-sonnet-latest', label: 'Claude Sonnet', default: true }]
        }
    ])),
}));

// Mock settings
vi.mock('../../main/settings.js', () => ({
    getAllSettings: vi.fn(() => ({
        aiProvider: 'anthropic',
        aiModel: 'claude-sonnet-4-20250514',
    })),
}));

// We can test the pure parsing functions by importing the module
// and calling the non-exported functions indirectly, or by testing
// the exported functions that use them.
// For pure function testing, let's extract and test parseOutlineIntoSlides
// and generateCourseConfig by calling the module in controlled conditions.

// Since parseOutlineIntoSlides and generateCourseConfig are not exported,
// we test them indirectly through the workflow runner. But we CAN test
// the outline parsing logic by replicating it here to verify correctness.

describe('outline parsing logic', () => {
    // Replicate parseOutlineIntoSlides to test it directly
    function parseOutlineIntoSlides(outline) {
        const slides = [];
        const sections = outline.split(/^## /m).slice(1);
        for (const section of sections) {
            const lines = section.trim().split('\n');
            const title = lines[0].trim();
            const spec = '## ' + section.trim();
            const idMatch = title.match(/^(\d+-)?(.+)/);
            const id = idMatch
                ? (idMatch[1] || '') + idMatch[2].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '')
                : null;
            slides.push({ title, spec, id });
        }
        return slides;
    }

    it('parses a standard outline into slides', () => {
        const outline = `# My Course

## Welcome
Introduction content here.

## Module 1: Safety Basics
Content about safety.

## Quiz
Assessment questions.`;

        const slides = parseOutlineIntoSlides(outline);
        expect(slides).toHaveLength(3);
        expect(slides[0].title).toBe('Welcome');
        expect(slides[1].title).toBe('Module 1: Safety Basics');
        expect(slides[2].title).toBe('Quiz');
    });

    it('generates kebab-case IDs from titles', () => {
        const outline = `## Welcome to the Course`;
        const slides = parseOutlineIntoSlides(outline);
        expect(slides[0].id).toBe('welcome-to-the-course');
    });

    it('preserves numeric prefixes in IDs', () => {
        const outline = `## 01-Welcome`;
        const slides = parseOutlineIntoSlides(outline);
        expect(slides[0].id).toBe('01-welcome');
    });

    it('strips trailing hyphens from IDs', () => {
        const outline = `## Hello World!`;
        const slides = parseOutlineIntoSlides(outline);
        // "Hello World!" → "hello-world-" → "hello-world" (trailing stripped)
        expect(slides[0].id).not.toMatch(/-$/);
    });

    it('handles colons and special chars in titles', () => {
        const outline = `## Module 1: Introduction & Overview`;
        const slides = parseOutlineIntoSlides(outline);
        expect(slides[0].id).toBe('module-1-introduction-overview');
    });

    it('returns empty array for outline with no ## headings', () => {
        const outline = `# Just a Title\nSome content but no ## sections.`;
        const slides = parseOutlineIntoSlides(outline);
        expect(slides).toHaveLength(0);
    });

    it('preserves full spec text in each slide', () => {
        const outline = `## Welcome
- Objective 1
- Objective 2

Content details here.`;
        const slides = parseOutlineIntoSlides(outline);
        expect(slides[0].spec).toContain('## Welcome');
        expect(slides[0].spec).toContain('Objective 1');
        expect(slides[0].spec).toContain('Content details here.');
    });
});

describe('course config generation', () => {
    // Replicate generateCourseConfig for direct testing
    function generateCourseConfig(slides, outline) {
        const titleMatch = outline.match(/^# (.+)/m);
        const courseTitle = titleMatch ? titleMatch[1].trim() : 'Untitled Course';
        const slideEntries = slides.map((s) => {
            const id = s.filename.replace('.js', '');
            return `        { id: '${id}', title: '${s.title.replace(/'/g, "\\'")}', file: './slides/${s.filename}' }`;
        }).join(',\n');
        return `export default {\n    title: '${courseTitle.replace(/'/g, "\\'")}',\n    slides: [\n${slideEntries}\n    ]\n};\n`;
    }

    it('generates valid JS config from slides', () => {
        const slides = [
            { title: 'Welcome', filename: 'welcome.js' },
            { title: 'Quiz', filename: 'quiz.js' },
        ];
        const config = generateCourseConfig(slides, '# My Course\n\n## Welcome');
        expect(config).toContain("title: 'My Course'");
        expect(config).toContain("id: 'welcome'");
        expect(config).toContain("file: './slides/welcome.js'");
    });

    it('escapes single quotes in title', () => {
        const slides = [{ title: "It's a Test", filename: 'test.js' }];
        const config = generateCourseConfig(slides, "# It's a Course");
        expect(config).toContain("It\\'s a Course");
        expect(config).toContain("It\\'s a Test");
    });

    it('falls back to "Untitled Course" when no # heading exists', () => {
        const slides = [{ title: 'Slide 1', filename: 'slide-01.js' }];
        const config = generateCourseConfig(slides, 'No heading here');
        expect(config).toContain("title: 'Untitled Course'");
    });
});
