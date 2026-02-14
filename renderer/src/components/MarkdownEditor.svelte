<script>
  import { onMount, onDestroy } from 'svelte';

  let { content = '', readonly = false, onSave = null, onUpdate = null } = $props();

  let editorEl;
  let editor;
  let hasUnsavedChanges = $state(false);

  onMount(async () => {
    const { Editor } = await import('@tiptap/core');
    const { default: StarterKit } = await import('@tiptap/starter-kit');
    const { Markdown } = await import('@tiptap/markdown');

    editor = new Editor({
      element: editorEl,
      extensions: [
        StarterKit,
        Markdown
      ],
      content,
      editable: !readonly,
      onUpdate: ({ editor: ed }) => {
        hasUnsavedChanges = true;
        onUpdate?.(ed.storage.markdown.getMarkdown());
      }
    });
  });

  onDestroy(() => {
    editor?.destroy();
  });

  export function getMarkdown() {
    return editor?.storage.markdown.getMarkdown() ?? content;
  }

  export function setContent(md) {
    if (editor) {
      editor.commands.setContent(md);
      hasUnsavedChanges = false;
    }
  }

  function handleSave() {
    if (editor && onSave) {
      onSave(editor.storage.markdown.getMarkdown());
      hasUnsavedChanges = false;
    }
  }

  function execCommand(cmd, ...args) {
    editor?.chain().focus()[cmd](...args).run();
  }
</script>

<div class="md-editor" class:readonly>
  {#if !readonly}
    <div class="md-toolbar">
      <div class="md-toolbar-group">
        <button class="md-btn" onclick={() => execCommand('toggleBold')} title="Bold">
          <strong>B</strong>
        </button>
        <button class="md-btn" onclick={() => execCommand('toggleItalic')} title="Italic">
          <em>I</em>
        </button>
      </div>
      <div class="md-toolbar-group">
        <button class="md-btn" onclick={() => execCommand('toggleHeading', { level: 1 })} title="Heading 1">
          H1
        </button>
        <button class="md-btn" onclick={() => execCommand('toggleHeading', { level: 2 })} title="Heading 2">
          H2
        </button>
        <button class="md-btn" onclick={() => execCommand('toggleHeading', { level: 3 })} title="Heading 3">
          H3
        </button>
      </div>
      <div class="md-toolbar-group">
        <button class="md-btn" onclick={() => execCommand('toggleBulletList')} title="Bullet list">
          •
        </button>
        <button class="md-btn" onclick={() => execCommand('toggleOrderedList')} title="Numbered list">
          1.
        </button>
      </div>
      <div class="md-toolbar-spacer"></div>
      {#if onSave}
        <button class="md-save-btn" class:unsaved={hasUnsavedChanges} onclick={handleSave} disabled={!hasUnsavedChanges}>
          {hasUnsavedChanges ? 'Save' : 'Saved'}
        </button>
      {/if}
    </div>
  {/if}

  <div class="md-content" bind:this={editorEl}></div>
</div>

<style>
  .md-editor {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg-primary);
  }

  .md-toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-secondary);
    flex-shrink: 0;
  }

  .md-toolbar-group {
    display: flex;
    gap: 1px;
  }

  .md-toolbar-group + .md-toolbar-group {
    margin-left: 8px;
    padding-left: 8px;
    border-left: 1px solid var(--border);
  }

  .md-toolbar-spacer {
    flex: 1;
  }

  .md-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
  }

  .md-btn:hover {
    background: var(--bg-elevated);
    color: var(--text-primary);
  }

  .md-save-btn {
    padding: 4px 12px;
    border: none;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    background: var(--bg-elevated);
    color: var(--text-tertiary);
    transition: all 150ms;
  }

  .md-save-btn.unsaved {
    background: var(--accent);
    color: white;
  }

  .md-save-btn:disabled {
    cursor: default;
    opacity: 0.7;
  }

  .md-content {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px;
  }

  /* Tiptap editor styles */
  .md-content :global(.tiptap) {
    outline: none;
    font-size: 14px;
    line-height: 1.6;
    color: var(--text-primary);
    min-height: 100%;
  }

  .md-content :global(.tiptap h1) {
    font-size: 22px;
    font-weight: 700;
    margin: 24px 0 8px;
    color: var(--text-primary);
  }

  .md-content :global(.tiptap h2) {
    font-size: 18px;
    font-weight: 600;
    margin: 20px 0 6px;
    color: var(--text-primary);
  }

  .md-content :global(.tiptap h3) {
    font-size: 15px;
    font-weight: 600;
    margin: 16px 0 4px;
    color: var(--text-secondary);
  }

  .md-content :global(.tiptap p) {
    margin: 4px 0 8px;
  }

  .md-content :global(.tiptap ul),
  .md-content :global(.tiptap ol) {
    margin: 4px 0 8px;
    padding-left: 24px;
  }

  .md-content :global(.tiptap li) {
    margin: 2px 0;
  }

  .md-content :global(.tiptap strong) {
    font-weight: 600;
    color: var(--text-primary);
  }

  .md-content :global(.tiptap code) {
    background: var(--bg-secondary);
    border-radius: 3px;
    padding: 1px 4px;
    font-family: var(--font-mono);
    font-size: 13px;
  }

  .md-content :global(.tiptap blockquote) {
    border-left: 3px solid var(--accent);
    margin: 8px 0;
    padding: 4px 12px;
    color: var(--text-secondary);
  }

  .md-content :global(.tiptap hr) {
    border: none;
    border-top: 1px solid var(--border);
    margin: 16px 0;
  }

  .readonly .md-content :global(.tiptap) {
    cursor: default;
  }
</style>
