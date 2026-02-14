<script>
  import { onMount } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import MarkdownEditor from '../components/MarkdownEditor.svelte';
  import { showToast } from '../stores/toast.js';

  let { projectPath, onClose } = $props();

  let outlineContent = $state('');
  let outlineExists = $state(false);
  let loading = $state(true);
  let editorRef = $state(null);

  onMount(async () => {
    await loadOutline();
  });

  async function loadOutline() {
    loading = true;
    try {
      const result = await window.api.outline.load(projectPath);
      outlineContent = result.content;
      outlineExists = result.exists;
    } catch (err) {
      showToast({ type: 'error', message: `Failed to load outline: ${err.message}` });
    }
    loading = false;
  }

  async function handleSave(markdown) {
    try {
      await window.api.outline.save(projectPath, markdown);
      outlineExists = true;
    } catch (err) {
      showToast({ type: 'error', message: `Failed to save outline: ${err.message}` });
    }
  }
</script>

<div class="outline-panel" data-testid="outline-panel">
  <div class="outline-header">
    <h3>Course Outline</h3>
    <div class="outline-header-actions">
      {#if outlineExists}
        <span class="outline-status">COURSE_OUTLINE.md</span>
      {/if}
      <button class="btn-ghost btn-sm" onclick={onClose} title="Close">
        <Icon size={16}><path d="M18 6 6 18"/><path d="m6 6 12 12"/></Icon>
      </button>
    </div>
  </div>

  <div class="outline-body">
    {#if loading}
      <div class="outline-empty">
        <span class="text-tertiary">Loading…</span>
      </div>
    {:else if !outlineExists && !outlineContent}
      <div class="outline-empty">
        <Icon size={32}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </Icon>
        <p>No outline yet</p>
        <span class="text-tertiary">Use "Build Course Outline" in the chat to generate one, or start writing below.</span>
        <button class="btn-secondary btn-sm" onclick={() => { outlineContent = '# Course Title\n\n## Slide 1: Introduction\n\n'; outlineExists = false; }}>
          Start from scratch
        </button>
      </div>
    {:else}
      <MarkdownEditor
        bind:this={editorRef}
        content={outlineContent}
        onSave={handleSave}
      />
    {/if}
  </div>
</div>

<style>
  .outline-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg-primary);
    border-left: 1px solid var(--border);
    width: 480px;
    min-width: 360px;
    position: relative;
  }

  .outline-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .outline-header h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }

  .outline-header-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .outline-status {
    font-size: 11px;
    font-family: var(--font-mono);
    color: var(--text-tertiary);
    padding: 2px 6px;
    background: var(--bg-secondary);
    border-radius: 3px;
  }

  .outline-body {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .outline-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 48px 24px;
    text-align: center;
    color: var(--text-tertiary);
    flex: 1;
  }

  .outline-empty p {
    margin: 4px 0 0;
    font-weight: 500;
    color: var(--text-secondary);
  }
</style>
