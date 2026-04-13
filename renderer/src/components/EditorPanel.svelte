<script>
  import { onMount, onDestroy } from 'svelte';
  import {
    openFile, dirty, editorContent, currentDir, dirEntries,
    loadDirectory, openFileInEditor, saveFile, closeFile
  } from '../stores/editor.js';
  import Icon from './Icon.svelte';

  let { projectPath } = $props();

  let editorContainer = $state(null);
  let editor = $state(null);
  let monaco = $state(null);
  let resizeObserver = null;

  // File tree state
  let expandedDirs = $state(new Set());
  let childEntries = $state({});  // path → FileEntry[]
  let showAllFiles = $state(false);

  onMount(async () => {
    // Load Monaco dynamically (heavy module)
    monaco = await import('monaco-editor');

    // Configure Monaco workers — use generic editor worker for all languages.
    // Language-specific workers (html, css, json, ts) cause issues with Vite's
    // dep optimizer in Electron, so we fall back to the base editor worker.
    self.MonacoEnvironment = {
      getWorker() {
        return new Worker(
          new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url),
          { type: 'module' }
        );
      }
    };

    // Define custom themes matching the app's design tokens
    defineThemes(monaco);

    // Detect initial theme
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

    // Create the editor instance
    editor = monaco.editor.create(editorContainer, {
      value: '',
      language: 'html',
      theme: isDark ? 'coursecode-dark' : 'coursecode-light',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      fontFamily: "'SF Mono', 'Cascadia Code', 'Consolas', 'Fira Code', monospace",
      lineNumbers: 'on',
      scrollBeyondLastLine: false,
      wordWrap: 'on',
      tabSize: 2,
      renderLineHighlight: 'line',
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      padding: { top: 8 }
    });

    // Cmd/Ctrl+S to save
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      saveFile(projectPath);
    });

    // Track content changes → store
    editor.onDidChangeModelContent(() => {
      editorContent.set(editor.getValue());
    });

    // Watch for theme changes
    const themeObserver = new MutationObserver(() => {
      const dark = document.documentElement.getAttribute('data-theme') === 'dark';
      monaco.editor.setTheme(dark ? 'coursecode-dark' : 'coursecode-light');
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    });

    // Load the initial directory listing
    const initialEntries = await loadDirectory(projectPath);

    // Auto-expand the slides directory if present
    const slidesEntry = initialEntries.find(e => e.type === 'directory' && e.name === 'slides');
    if (slidesEntry) {
      await toggleDir(slidesEntry.path);
    }

    return () => {
      themeObserver.disconnect();
    };
  });

  onDestroy(() => {
    editor?.dispose();
    resizeObserver?.disconnect();
  });

  // React to openFile changes — load content into Monaco.
  // Both `editor` and `monaco` are reactive ($state) so this effect also
  // fires when Monaco finishes initializing after a deferred first mount.
  $effect(() => {
    const file = $openFile;
    const ed = editor;
    const m = monaco;
    if (ed && m && file) {
      const model = m.editor.createModel(file.content, file.language);
      ed.setModel(model);
    } else if (ed && !file) {
      ed.setModel(null);
    }
  });

  function defineThemes(m) {
    m.editor.defineTheme('coursecode-light', {
      base: 'vs',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#ffffff',
        'editor.foreground': '#14213d',
        'editor.lineHighlightBackground': '#f0f0f3',
        'editorLineNumber.foreground': '#8888a8',
        'editorCursor.foreground': '#f18701',
        'editor.selectionBackground': 'rgba(241, 135, 1, 0.15)',
        'editorWidget.background': '#fafafa',
        'editorWidget.border': '#e2e2ea'
      }
    });

    m.editor.defineTheme('coursecode-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#0a0f1a',
        'editor.foreground': '#e8e8f0',
        'editor.lineHighlightBackground': '#111b2e',
        'editorLineNumber.foreground': '#6a6a8a',
        'editorCursor.foreground': '#f59b2d',
        'editor.selectionBackground': 'rgba(245, 155, 45, 0.2)',
        'editorWidget.background': '#182640',
        'editorWidget.border': '#1e2d45'
      }
    });
  }

  // --- File tree helpers ---

  async function handleEntryClick(entry) {
    if (entry.type === 'directory') {
      await toggleDir(entry.path);
    } else {
      await openFileInEditor(projectPath, entry.path);
    }
  }

  async function toggleDir(dirPath) {
    const newExpanded = new Set(expandedDirs);
    if (newExpanded.has(dirPath)) {
      newExpanded.delete(dirPath);
    } else {
      newExpanded.add(dirPath);
      if (!childEntries[dirPath]) {
        const result = await window.api.files.listDir(projectPath, dirPath);
        childEntries = { ...childEntries, [dirPath]: result.entries };
      }
    }
    expandedDirs = newExpanded;
  }

  async function navigateUp() {
    const cur = $currentDir;
    if (!cur) return; // already at root
    const parts = cur.split('/');
    parts.pop();
    const parent = parts.join('/');
    await loadDirectory(projectPath, parent);
    expandedDirs = new Set();
    childEntries = {};
  }

  function getFileIcon(entry) {
    if (entry.type === 'directory') return '📁';
    const ext = entry.extension || '';
    if (ext === '.html' || ext === '.htm') return '🌐';
    if (ext === '.css') return '🎨';
    if (ext === '.js' || ext === '.mjs') return '⚡';
    if (ext === '.json') return '📋';
    if (ext === '.md') return '📝';
    if (ext === '.svg') return '🖼️';
    return '📄';
  }
</script>

<div class="editor-panel">
  <!-- Sidebar file tree -->
  <div class="file-tree">
    <div class="file-tree-header">
      {#if $currentDir}
        <button class="nav-up-btn" onclick={navigateUp} title="Go up">
          <Icon size={14}>
            <polyline points="15 18 9 12 15 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </Icon>
        </button>
      {/if}
      <span class="tree-label">{$currentDir || 'Project'}</span>
    </div>

    <div class="file-tree-body">
      {#each $dirEntries as entry}
        <button
          class="tree-entry"
          class:active={$openFile?.path === entry.path}
          onclick={() => handleEntryClick(entry)}
        >
          <span class="entry-icon">{getFileIcon(entry)}</span>
          <span class="entry-name">{entry.name}</span>
          {#if entry.type === 'directory'}
            <Icon size={10} class="chevron-icon" style={expandedDirs.has(entry.path) ? 'transform: rotate(90deg)' : ''}>
              <path d="M4 3l4 3-4 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </Icon>
          {/if}
        </button>

        {#if entry.type === 'directory' && expandedDirs.has(entry.path) && childEntries[entry.path]}
          <div class="subtree">
            {#each childEntries[entry.path] as child}
              <button
                class="tree-entry sub-entry"
                class:active={$openFile?.path === child.path}
                onclick={() => handleEntryClick(child)}
              >
                <span class="entry-icon">{getFileIcon(child)}</span>
                <span class="entry-name">{child.name}</span>
              </button>
            {/each}
          </div>
        {/if}
      {/each}
    </div>
  </div>

  <!-- Editor area -->
  <div class="editor-area">
    {#if $openFile}
      <div class="editor-breadcrumb">
        <span class="breadcrumb-path">{$openFile.path}</span>
        {#if $dirty}
          <span class="dirty-dot" title="Unsaved changes">●</span>
        {/if}
        <div class="breadcrumb-spacer"></div>
        <button class="breadcrumb-btn" onclick={() => saveFile(projectPath)} disabled={!$dirty} title="Save (⌘S)">
          Save
        </button>
        <button class="breadcrumb-btn" onclick={closeFile} title="Close file">
          ✕
        </button>
      </div>
    {/if}

    <div class="monaco-container" bind:this={editorContainer}>
      {#if !$openFile}
        <div class="editor-empty">
          <div class="empty-icon">📝</div>
          <p>Select a file to edit</p>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .editor-panel {
    display: flex;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }

  /* --- File Tree Sidebar --- */
  .file-tree {
    width: 180px;
    min-width: 140px;
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    background: var(--bg-primary);
    flex-shrink: 0;
  }

  .file-tree-header {
    display: flex;
    align-items: center;
    gap: var(--sp-xs);
    padding: var(--sp-sm) var(--sp-sm);
    border-bottom: 1px solid var(--border);
    background: var(--bg-elevated);
    flex-shrink: 0;
  }

  .nav-up-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border: none;
    background: none;
    color: var(--text-tertiary);
    cursor: pointer;
    border-radius: var(--radius-sm);
    flex-shrink: 0;
  }

  .nav-up-btn:hover {
    background: var(--bg-secondary);
    color: var(--text-primary);
  }

  .tree-label {
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-tree-body {
    flex: 1;
    overflow-y: auto;
    padding: var(--sp-xs) 0;
  }

  .tree-entry {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 3px var(--sp-sm);
    border: none;
    background: none;
    color: var(--text-primary);
    font-size: var(--text-xs);
    cursor: pointer;
    text-align: left;
    transition: background var(--duration-fast) var(--ease);
  }

  .tree-entry:hover {
    background: var(--bg-secondary);
  }

  .tree-entry.active {
    background: var(--accent-subtle);
    color: var(--accent);
    font-weight: 500;
  }

  .sub-entry {
    padding-left: calc(var(--sp-sm) + 14px);
  }

  .entry-icon {
    font-size: 12px;
    flex-shrink: 0;
    line-height: 1;
  }

  .entry-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .subtree {
    /* Indent children */
  }

  /* --- Editor Area --- */
  .editor-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
  }

  .editor-breadcrumb {
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
    padding: 4px var(--sp-sm);
    background: var(--bg-elevated);
    border-bottom: 1px solid var(--border);
    font-size: var(--text-xs);
    flex-shrink: 0;
  }

  .breadcrumb-path {
    color: var(--text-secondary);
    font-family: var(--font-mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dirty-dot {
    color: var(--accent);
    font-size: 10px;
    flex-shrink: 0;
  }

  .breadcrumb-spacer {
    flex: 1;
  }

  .breadcrumb-btn {
    padding: 2px 8px;
    border: none;
    background: none;
    color: var(--text-tertiary);
    font-size: var(--text-xs);
    cursor: pointer;
    border-radius: var(--radius-sm);
    transition: all var(--duration-fast) var(--ease);
  }

  .breadcrumb-btn:hover:not(:disabled) {
    background: var(--bg-secondary);
    color: var(--text-primary);
  }

  .breadcrumb-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .monaco-container {
    flex: 1;
    min-height: 0;
    position: relative;
  }

  .editor-empty {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--sp-sm);
    color: var(--text-tertiary);
    font-size: var(--text-sm);
    background: var(--bg-primary);
  }

  .empty-icon {
    font-size: 32px;
    opacity: 0.5;
  }
</style>
