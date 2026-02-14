<script>
  let { items = [], visible = false, onSelect, selectedIndex = 0 } = $props();

  function handleKeydown(e) {
    // Handled by parent component
  }

  function getIcon(type) {
    if (type === 'slide') return '📄';
    if (type === 'ref') return '📚';
    if (type === 'interaction') return '🧩';
    return '📎';
  }

  function getLabel(item) {
    if (item.type === 'slide') return item.title;
    if (item.type === 'ref') return item.filename;
    if (item.type === 'interaction') return item.id;
    return item.title || item.id || item.filename;
  }

  function getCategory(type) {
    if (type === 'slide') return 'Slides';
    if (type === 'ref') return 'References';
    if (type === 'interaction') return 'Interactions';
    return 'Other';
  }

  // Group items by type
  let grouped = $derived(groupByType(items));

  function groupByType(items) {
    const groups = {};
    for (const item of items) {
      const cat = getCategory(item.type);
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(item);
    }
    return groups;
  }

  // Flat index for keyboard navigation
  let flatIndex = 0;
</script>

{#if visible && items.length > 0}
  <div class="mention-dropdown">
    {#each Object.entries(grouped) as [category, groupItems]}
      <div class="mention-group">
        <div class="mention-group-label">{category}</div>
        {#each groupItems as item, i}
          {@const globalIdx = items.indexOf(item)}
          <button
            class="mention-item"
            class:selected={globalIdx === selectedIndex}
            onclick={() => onSelect(item)}
            onmouseenter={() => {}}
          >
            <span class="mention-icon">{getIcon(item.type)}</span>
            <span class="mention-label">{getLabel(item)}</span>
            <span class="mention-type">{item.type}</span>
          </button>
        {/each}
      </div>
    {/each}
  </div>
{/if}

<style>
  .mention-dropdown {
    position: absolute;
    bottom: 100%;
    left: 0;
    right: 0;
    max-height: 240px;
    overflow-y: auto;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
    margin-bottom: var(--sp-xs);
    z-index: 50;
    animation: slideUp 0.15s var(--ease);
  }

  @keyframes slideUp {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .mention-group {
    padding: var(--sp-xs) 0;
  }

  .mention-group:not(:last-child) {
    border-bottom: 1px solid var(--border);
  }

  .mention-group-label {
    padding: var(--sp-xs) var(--sp-md);
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .mention-item {
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

  .mention-item:hover,
  .mention-item.selected {
    background: var(--accent-subtle);
  }

  .mention-icon {
    flex-shrink: 0;
    font-size: var(--text-base);
  }

  .mention-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mention-type {
    flex-shrink: 0;
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }
</style>
