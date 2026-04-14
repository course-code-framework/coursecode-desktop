<script>
  let {
    items = [],
    visible = false,
    onSelect,
    onBrowse,
    onDismiss
  } = $props();

  let searchQuery = $state('');
  let pickerEl = $state(null);

  // Group items by type
  let filtered = $derived(filterItems(searchQuery));

  function filterItems(q) {
    const query = q.toLowerCase();
    const slides = [];
    const refs = [];
    const interactions = [];

    for (const item of items) {
      const label = (item.title || item.filename || item.id || '').toLowerCase();
      const file = (item.file || '').toLowerCase();
      if (query && !label.includes(query) && !file.includes(query)) continue;

      if (item.type === 'slide') slides.push(item);
      else if (item.type === 'ref') refs.push(item);
      else if (item.type === 'interaction') interactions.push(item);
    }

    return { slides, refs, interactions };
  }

  function getIcon(type) {
    if (type === 'slide') return '📄';
    if (type === 'ref') return '📚';
    if (type === 'interaction') return '🧩';
    return '📎';
  }

  function handleClickOutside(e) {
    if (pickerEl && !pickerEl.contains(e.target)) {
      onDismiss?.();
    }
  }

  function handleKeydown(e) {
    if (e.key === 'Escape') {
      onDismiss?.();
    }
  }

  $effect(() => {
    if (visible) {
      searchQuery = '';
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeydown);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
        document.removeEventListener('keydown', handleKeydown);
      };
    }
  });
</script>

{#if visible}
  <div class="attach-picker" bind:this={pickerEl}>
    <div class="attach-search">
      <svg class="search-icon" width="14" height="14" viewBox="0 0 16 16" fill="none">
        <circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.3"/>
        <path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
      </svg>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        type="text"
        placeholder="Search files…"
        bind:value={searchQuery}
        autofocus
      />
    </div>

    <div class="attach-body">
      {#if filtered.slides.length > 0}
        <div class="attach-group">
          <div class="attach-group-label">Course Files</div>
          {#each filtered.slides as item}
            <button class="attach-item" onclick={() => onSelect(item)}>
              <span class="attach-icon">{getIcon(item.type)}</span>
              <span class="attach-label">{item.file || item.id}</span>
              <span class="attach-detail">{item.title}</span>
            </button>
          {/each}
        </div>
      {/if}

      {#if filtered.refs.length > 0}
        <div class="attach-group">
          <div class="attach-group-label">References</div>
          {#each filtered.refs as item}
            <button class="attach-item" onclick={() => onSelect(item)}>
              <span class="attach-icon">{getIcon(item.type)}</span>
              <span class="attach-label">{item.filename}</span>
            </button>
          {/each}
        </div>
      {/if}

      {#if filtered.interactions.length > 0}
        <div class="attach-group">
          <div class="attach-group-label">Interactions</div>
          {#each filtered.interactions as item}
            <button class="attach-item" onclick={() => onSelect(item)}>
              <span class="attach-icon">{getIcon(item.type)}</span>
              <span class="attach-label">{item.id}</span>
            </button>
          {/each}
        </div>
      {/if}

      {#if filtered.slides.length === 0 && filtered.refs.length === 0 && filtered.interactions.length === 0}
        <div class="attach-empty">No matches</div>
      {/if}
    </div>

    <div class="attach-footer">
      <button class="attach-browse" onclick={onBrowse}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M2 8h12M8 2v12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        Browse Files…
      </button>
    </div>
  </div>
{/if}

<style>
  .attach-picker {
    position: absolute;
    bottom: 100%;
    left: 0;
    right: 0;
    max-height: 340px;
    display: flex;
    flex-direction: column;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
    margin-bottom: var(--sp-xs);
    z-index: 50;
    animation: pickerSlideUp 0.15s var(--ease);
    overflow: hidden;
  }

  @keyframes pickerSlideUp {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .attach-search {
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
    padding: var(--sp-sm) var(--sp-md);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .search-icon {
    flex-shrink: 0;
    color: var(--text-tertiary);
  }

  .attach-search input {
    flex: 1;
    background: none;
    border: none;
    outline: none;
    color: var(--text-primary);
    font-size: var(--text-sm);
    font-family: inherit;
    padding: 0;
  }

  .attach-search input::placeholder {
    color: var(--text-tertiary);
  }

  .attach-body {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }

  .attach-group {
    padding: var(--sp-xs) 0;
  }

  .attach-group:not(:last-child) {
    border-bottom: 1px solid var(--border);
  }

  .attach-group-label {
    padding: var(--sp-xs) var(--sp-md);
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .attach-item {
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
    width: 100%;
    padding: var(--sp-sm) var(--sp-md);
    background: none;
    border: none;
    border-radius: 0;
    color: var(--text-primary);
    font-size: var(--text-sm);
    cursor: pointer;
    text-align: left;
    transition: background var(--duration-fast) var(--ease);
  }

  .attach-item:hover {
    background: var(--accent-subtle);
  }

  .attach-icon {
    flex-shrink: 0;
    font-size: var(--text-base);
  }

  .attach-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .attach-detail {
    flex-shrink: 0;
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }

  .attach-empty {
    padding: var(--sp-lg) var(--sp-md);
    text-align: center;
    color: var(--text-tertiary);
    font-size: var(--text-sm);
  }

  .attach-footer {
    border-top: 1px solid var(--border);
    padding: var(--sp-xs) var(--sp-sm);
    flex-shrink: 0;
  }

  .attach-browse {
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
    width: 100%;
    padding: var(--sp-sm) var(--sp-md);
    background: none;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: var(--text-sm);
    cursor: pointer;
    text-align: left;
    transition: background var(--duration-fast) var(--ease), color var(--duration-fast) var(--ease);
  }

  .attach-browse:hover {
    background: var(--accent-subtle);
    color: var(--text-primary);
  }
</style>
