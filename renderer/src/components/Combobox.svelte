<script>
  import { createEventDispatcher } from 'svelte';

  let {
    options = [],
    value = '',
    placeholder = 'Select',
    disabled = false,
    searchable = false,
    emptyLabel = 'No options'
  } = $props();

  const dispatch = createEventDispatcher();

  let open = false;
  let query = '';

  let selected = $derived(options.find(o => o.value === value) || null);
  let filtered = $derived(query.trim()
    ? options.filter(o => o.label.toLowerCase().includes(query.trim().toLowerCase()))
    : options);

  function toggle() {
    if (disabled) return;
    open = !open;
    if (!open) query = '';
  }

  function close() {
    open = false;
    query = '';
  }

  function pick(option) {
    if (option.disabled) return;
    dispatch('change', { value: option.value });
    close();
  }
</script>

<div class="combobox">
  <button class="combobox-trigger" class:disabled={disabled} onclick={toggle} disabled={disabled}>
    <span class="combobox-label">{selected?.label || placeholder}</span>
    <svg class="chevron" class:open width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M2 4l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </button>

  {#if open}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="backdrop" onclick={close}></div>
    <div class="combobox-menu">
      {#if searchable}
        <div class="search-wrap">
          <input class="search-input" type="text" bind:value={query} placeholder="Search..." />
        </div>
      {/if}

      {#if filtered.length === 0}
        <div class="empty">{emptyLabel}</div>
      {:else}
        {#each filtered as option}
          <button
            class="option"
            class:selected={option.value === value}
            class:disabled={option.disabled}
            onclick={() => pick(option)}
            disabled={option.disabled}
          >
            <span>{option.label}</span>
            {#if option.value === value}
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M3 7l3 3 5-5.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            {/if}
          </button>
        {/each}
      {/if}
    </div>
  {/if}
</div>

<style>
  .combobox { position: relative; width: 100%; }

  .combobox-trigger {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-sm);
    font-family: inherit;
    font-size: var(--text-base);
    padding: var(--sp-sm) var(--sp-md);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-input);
    color: var(--text-primary);
    text-align: left;
  }

  .combobox-trigger.disabled { opacity: 0.5; pointer-events: none; cursor: default; }
  .combobox-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .chevron { transition: transform var(--duration-fast) var(--ease); }
  .chevron.open { transform: rotate(180deg); }

  .backdrop { position: fixed; inset: 0; z-index: 39; }

  .combobox-menu {
    position: absolute;
    top: calc(100% + var(--sp-xs));
    left: 0;
    right: 0;
    z-index: 40;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
    max-height: 280px;
    overflow: auto;
  }

  .search-wrap { padding: var(--sp-xs); border-bottom: 1px solid var(--border); }
  .search-input {
    width: 100%;
    font-family: inherit;
    font-size: var(--text-sm);
    padding: var(--sp-xs) var(--sp-sm);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-input);
    color: var(--text-primary);
  }

  .option {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-sm);
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: var(--text-sm);
    padding: var(--sp-sm) var(--sp-md);
    text-align: left;
  }

  .option:hover:not(.disabled) { background: var(--bg-secondary); }
  .option.selected { color: var(--accent); font-weight: 600; }
  .option.disabled { opacity: 0.5; pointer-events: none; cursor: default; }

  .empty {
    padding: var(--sp-sm) var(--sp-md);
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
</style>
