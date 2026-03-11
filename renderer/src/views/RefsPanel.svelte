<script>
  import { onMount } from 'svelte';

  let { projectPath, compact = false, onCountUpdate, onViewRef } = $props();

  let refs = $state([]);
  let loading = $state(true);
  let converting = $state(false);
  let convertProgress = $state('');

  onMount(async () => {
    await loadRefs();

    const unsub = window.api.refs.onConvertProgress(({ status, text }) => {
      convertProgress = text;
    });

    return () => unsub();
  });

  async function loadRefs() {
    loading = true;
    try {
      refs = await window.api.refs.list(projectPath);
      onCountUpdate?.(refs.length);
    } catch {
      refs = [];
      onCountUpdate?.(0);
    }
    loading = false;
  }

  async function handleDrop(e) {
    e.preventDefault();
    dragOver = false;
    dragCounter = 0;

    const files = Array.from(e.dataTransfer.files);
    const supported = files.filter(f =>
      /\.(pdf|docx|pptx|txt|md)$/i.test(f.name)
    );

    if (supported.length === 0) return;

    converting = true;
    convertProgress = 'Preparing files…';

    try {
      for (const file of supported) {
        convertProgress = `Converting ${file.name}…`;
        const filePath = window.api.getFilePath(file);
        await window.api.refs.convert(projectPath, filePath);
      }
      await loadRefs();
    } catch (err) {
      convertProgress = `Error: ${err.message}`;
    }

    converting = false;
    convertProgress = '';
  }

  let dragOver = $state(false);
  let dragCounter = 0;

  function handleDragEnter(e) {
    e.preventDefault();
    dragCounter++;
    dragOver = true;
  }

  function handleDragOver(e) {
    e.preventDefault();
  }

  function handleDragLeave() {
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      dragOver = false;
    }
  }
</script>

<div
  class="refs-panel"
  class:compact
  ondrop={handleDrop}
  ondragenter={handleDragEnter}
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  role="region"
  aria-label="Reference documents"
  data-testid="refs-panel"
>
  {#if loading}
    <div class="refs-loading">
      <span class="spinner"></span>
      <span>Loading…</span>
    </div>
  {:else if refs.length === 0 && !converting}
    <div class="refs-empty" class:drag-active={dragOver}>
      <p>Drop reference docs here</p>
      <p class="hint">PDF, DOCX, PPTX, TXT → markdown</p>
    </div>
  {:else}
    {#if converting}
      <div class="convert-status">
        <span class="spinner"></span>
        <span>{convertProgress}</span>
      </div>
    {/if}

    <div class="refs-list">
      {#each refs as ref}
        <button
          class="ref-item"
          onclick={() => onViewRef?.(ref)}
        >
          <span class="ref-icon">📄</span>
          <span class="ref-name">{ref.filename}</span>
          <span class="ref-meta">{ref.sizeLabel}</span>
        </button>
      {/each}
    </div>

    <div class="refs-drop-hint" class:drag-active={dragOver}>
      <span>+ Drop files to add</span>
    </div>

    {#if dragOver}
      <div class="drop-overlay">
        <div class="drop-message">Drop to add</div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .refs-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg-primary);
    position: relative;
  }

  .refs-panel.compact {
    height: auto;
  }

  .refs-loading {
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
    padding: var(--sp-sm) var(--sp-md);
    color: var(--text-secondary);
    font-size: var(--text-xs);
  }

  /* Empty / drop state */
  .refs-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: var(--sp-md);
    color: var(--text-tertiary);
    border: 2px dashed transparent;
    margin: var(--sp-xs);
    border-radius: var(--radius-md);
    transition: all var(--duration-fast) var(--ease);
  }

  .refs-empty.drag-active {
    border-color: var(--accent);
    background: var(--accent-subtle);
  }

  .refs-empty p {
    margin: 0;
    font-size: var(--text-xs);
  }

  .hint {
    color: var(--text-tertiary);
    margin-top: 2px !important;
  }

  /* Convert status */
  .convert-status {
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
    padding: var(--sp-xs) var(--sp-md);
    background: var(--accent-subtle);
    color: var(--accent);
    font-size: var(--text-xs);
  }

  /* Ref list */
  .refs-list {
    padding: var(--sp-xs);
  }

  .refs-drop-hint {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--sp-md);
    margin: 0 var(--sp-xs) var(--sp-xs);
    border: 2px dashed var(--border);
    border-radius: var(--radius-md);
    color: var(--text-tertiary);
    font-size: var(--text-xs);
    transition: all var(--duration-fast) var(--ease);
    cursor: default;
  }

  .refs-drop-hint.drag-active {
    border-color: var(--accent);
    background: var(--accent-subtle);
    color: var(--accent);
  }

  .ref-item {
    display: flex;
    align-items: center;
    gap: var(--sp-xs);
    width: 100%;
    padding: var(--sp-xs) var(--sp-sm);
    background: none;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: var(--text-xs);
    cursor: pointer;
    text-align: left;
    transition: background var(--duration-fast) var(--ease);
  }

  .ref-item:hover {
    background: var(--bg-secondary);
  }

  .ref-item.selected {
    background: var(--accent-subtle);
  }

  .ref-icon {
    flex-shrink: 0;
    font-size: var(--text-sm);
  }

  .ref-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }

  .ref-meta {
    flex-shrink: 0;
    color: var(--text-tertiary);
  }

  /* Drop overlay */
  .drop-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(var(--accent-rgb, 99, 102, 241), 0.08);
    border: 2px dashed var(--accent);
    border-radius: var(--radius-md);
    z-index: 10;
  }

  .drop-message {
    padding: var(--sp-sm) var(--sp-md);
    background: var(--bg-elevated);
    border-radius: var(--radius-sm);
    font-weight: 600;
    font-size: var(--text-sm);
    color: var(--accent);
    box-shadow: var(--shadow-md);
  }

  .spinner {
    width: 12px;
    height: 12px;
    border: 2px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
    flex-shrink: 0;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
