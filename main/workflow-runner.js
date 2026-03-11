/**
 * workflow-runner.js — Orchestrates purpose-built AI sub-conversations
 *
 * Two workflows:
 *   build-outline: Single conversation (template + guide + refs → COURSE_OUTLINE.md)
 *   build-course:  One conversation per slide (authoring guide + slide spec → slide files)
 */

import { join } from 'path';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { createProvider, loadApiKey, estimateCost, getProviders } from './llm-provider.js';
import { getAllSettings } from './settings.js';
import { WORKFLOW_CONFIGS, DEFAULT_PROVIDER, MAX_TOKENS } from './ai-config.js';
import { createLogger } from './logger.js';

const log = createLogger('workflow');

// Track active workflows for cancellation
const activeWorkflows = new Map();

/**
 * Run a guided workflow.
 * @param {string} workflowId - 'build-outline' or 'build-course'
 * @param {string} projectPath - Absolute path to the course project
 * @param {Electron.WebContents} webContents - For streaming progress events
 */
export async function runWorkflow(workflowId, projectPath, webContents) {
    const config = WORKFLOW_CONFIGS[workflowId];
    if (!config) throw new Error(`Unknown workflow: ${workflowId}`);

    // Cancellation token
    const controller = new AbortController();
    activeWorkflows.set(projectPath, controller);

    const emit = (type, data) => {
        if (!webContents.isDestroyed()) {
            webContents.send('workflow:progress', { workflowId, ...data, type });
        }
    };

    try {
        emit('start', { message: `Starting ${config.label}…` });

        if (workflowId === 'build-outline') {
            await runBuildOutline(projectPath, config, emit, controller.signal);
        } else if (workflowId === 'build-course') {
            await runBuildCourse(projectPath, config, emit, controller.signal);
        }

        emit('complete', { message: `${config.label} complete!` });
        return { success: true };
    } catch (err) {
        if (err.name === 'AbortError') {
            emit('cancelled', { message: 'Workflow cancelled.' });
            return { success: false, cancelled: true };
        }
        log.error(`Workflow ${workflowId} failed`, err);
        emit('error', { message: err.message });
        return { success: false, error: err.message };
    } finally {
        activeWorkflows.delete(projectPath);
    }
}

export function cancelWorkflow(projectPath) {
    const controller = activeWorkflows.get(projectPath);
    if (controller) {
        controller.abort();
        return true;
    }
    return false;
}

// --- Build Outline Workflow ---

async function runBuildOutline(projectPath, config, emit, signal) {
    // 1. Read framework docs
    emit('step', { message: 'Loading outline template and guide…' });

    const docsDir = join(projectPath, 'framework', 'docs');
    const templatePath = join(docsDir, 'COURSE_OUTLINE_TEMPLATE.md');
    const guidePath = join(docsDir, 'COURSE_OUTLINE_GUIDE.md');

    const template = safeReadFile(templatePath, 'COURSE_OUTLINE_TEMPLATE.md');
    const guide = safeReadFile(guidePath, 'COURSE_OUTLINE_GUIDE.md');

    // 2. Read all reference documents
    emit('step', { message: 'Reading reference documents…' });

    const refsDir = join(projectPath, 'course', 'references', 'md');
    const refs = readAllRefs(refsDir);

    if (refs.length === 0) {
        throw new Error('No reference documents found. Add reference materials before building an outline.');
    }

    emit('step', { message: `Found ${refs.length} reference document${refs.length !== 1 ? 's' : ''}. Generating outline…` });

    // 3. Assemble context
    const userMessage = [
        '## Outline Template\n\n' + template,
        '## Outline Guide\n\n' + guide,
        '## Reference Documents\n\n' + refs.map(r => `### ${r.name}\n\n${r.content}`).join('\n\n---\n\n')
    ].join('\n\n---\n\n');

    // 4. Run single LLM conversation
    const result = await runLLMConversation({
        systemPrompt: config.systemPrompt,
        userMessage,
        signal,
        onStream: (text) => emit('stream', { text })
    });

    // 5. Write output
    const outlinePath = join(projectPath, 'course', 'COURSE_OUTLINE.md');
    mkdirSync(join(projectPath, 'course'), { recursive: true });
    writeFileSync(outlinePath, result, 'utf-8');

    emit('step', { message: 'Outline saved to course/COURSE_OUTLINE.md' });
    log.info('Outline generated', { projectPath, length: result.length });
}

// --- Build Course Workflow ---

async function runBuildCourse(projectPath, config, emit, signal) {
    // 1. Read the outline
    emit('step', { message: 'Reading course outline…' });

    const outlinePath = join(projectPath, 'course', 'COURSE_OUTLINE.md');
    if (!existsSync(outlinePath)) {
        throw new Error('No course outline found. Build an outline first.');
    }
    const outline = readFileSync(outlinePath, 'utf-8');

    // 2. Parse outline into per-slide specs
    const slides = parseOutlineIntoSlides(outline);
    if (slides.length === 0) {
        throw new Error('Could not parse any slide specs from the outline. Check the outline format.');
    }

    emit('step', { message: `Found ${slides.length} slides in outline. Loading authoring guide…` });

    // 3. Read authoring guide
    const docsDir = join(projectPath, 'framework', 'docs');
    const authoringGuide = safeReadFile(
        join(docsDir, 'COURSE_AUTHORING_GUIDE.md'),
        'COURSE_AUTHORING_GUIDE.md'
    );

    // 4. Build each slide in a fresh conversation
    const results = [];
    for (let i = 0; i < slides.length; i++) {
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');

        const slide = slides[i];
        emit('step', {
            message: `Building slide ${i + 1} of ${slides.length}: "${slide.title}"`,
            current: i + 1,
            total: slides.length
        });

        const userMessage = [
            '## Course Authoring Guide\n\n' + authoringGuide,
            '## Slide Specification (from outline)\n\n' + slide.spec,
            `\nWrite the slide module for "${slide.title}". Output ONLY the complete JavaScript module code.`
        ].join('\n\n---\n\n');

        const slideCode = await runLLMConversation({
            systemPrompt: config.systemPrompt,
            userMessage,
            signal,
            onStream: (text) => emit('stream', { text, slideIndex: i })
        });

        // Write slide file
        const slidesDir = join(projectPath, 'course', 'slides');
        mkdirSync(slidesDir, { recursive: true });
        const filename = slide.id ? `${slide.id}.js` : `slide-${String(i + 1).padStart(2, '0')}.js`;
        writeFileSync(join(slidesDir, filename), slideCode, 'utf-8');

        results.push({ title: slide.title, filename });
        emit('slideComplete', {
            message: `✓ Slide ${i + 1}: "${slide.title}"`,
            current: i + 1,
            total: slides.length
        });
    }

    emit('step', { message: `All ${slides.length} slides built. Generating course config…` });

    // 5. Generate course-config.js
    const configContent = generateCourseConfig(results, outline);
    writeFileSync(join(projectPath, 'course', 'course-config.js'), configContent, 'utf-8');

    log.info('Course built', { projectPath, slideCount: slides.length });
}

// --- LLM Conversation Runner ---

async function runLLMConversation({ systemPrompt, userMessage, signal, onStream }) {
    const settings = getAllSettings();
    const providerName = settings.aiProvider || DEFAULT_PROVIDER;
    const providerCatalog = await getProviders();
    const providerModels = providerCatalog.find(p => p.id === providerName)?.models || [];
    const configuredModel = settings.aiModel;
    const modelId = providerModels.some(m => m.id === configuredModel)
        ? configuredModel
        : (providerModels.find(m => m.default)?.id || providerModels[0]?.id);
    const apiKey = loadApiKey(providerName);

    if (!modelId) {
        throw new Error(`No models available for provider: ${providerName}`);
    }

    if (!apiKey) {
        throw new Error(`No API key configured for ${providerName}. Set one in Settings.`);
    }

    const provider = await createProvider(providerName, apiKey);
    const messages = [{ role: 'user', content: userMessage }];

    let fullText = '';

    for await (const event of provider.chat({
        messages,
        system: systemPrompt,
        model: modelId,
        signal
    })) {
        if (event.type === 'text') {
            fullText += event.text;
            onStream?.(fullText);
        }
    }

    // Extract code block if the response is wrapped in one
    const codeBlockMatch = fullText.match(/```(?:javascript|js)?\n([\s\S]*?)```/);
    if (codeBlockMatch) {
        return codeBlockMatch[1].trim();
    }

    return fullText.trim();
}

// --- Outline Parser ---

function parseOutlineIntoSlides(outline) {
    const slides = [];
    // Split by ## headings (each slide is a section)
    const sections = outline.split(/^## /m).slice(1);

    for (const section of sections) {
        const lines = section.trim().split('\n');
        const title = lines[0].trim();
        const spec = '## ' + section.trim();

        // Try to extract a slide ID from the title (e.g., "01-welcome" or "welcome")
        const idMatch = title.match(/^(\d+-)?(.+)/);
        const id = idMatch
            ? (idMatch[1] || '') + idMatch[2].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '')
            : null;

        slides.push({ title, spec, id });
    }

    return slides;
}

// --- Helpers ---

function safeReadFile(filePath, label) {
    if (!existsSync(filePath)) {
        throw new Error(`Required framework doc not found: ${label} (expected at ${filePath})`);
    }
    return readFileSync(filePath, 'utf-8');
}

function readAllRefs(refsDir) {
    if (!existsSync(refsDir)) return [];

    return readdirSync(refsDir)
        .filter(f => f.endsWith('.md'))
        .map(f => ({
            name: f.replace('.md', ''),
            content: readFileSync(join(refsDir, f), 'utf-8')
        }));
}

function generateCourseConfig(slides, outline) {
    // Extract course title from outline (first # heading)
    const titleMatch = outline.match(/^# (.+)/m);
    const courseTitle = titleMatch ? titleMatch[1].trim() : 'Untitled Course';

    const slideEntries = slides.map((s, i) => {
        const id = s.filename.replace('.js', '');
        return `        { id: '${id}', title: '${s.title.replace(/'/g, "\\'")}', file: './slides/${s.filename}' }`;
    }).join(',\n');

    return `export default {
    title: '${courseTitle.replace(/'/g, "\\'")}',
    slides: [
${slideEntries}
    ]
};
`;
}
