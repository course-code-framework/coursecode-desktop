<script>
  import { tabs, activeTabId, setActiveTab, closeTab } from '../stores/tabs.js';
  import { settings, updateSetting } from '../stores/settings.js';

  let { onTabClose, onOpenSettings } = $props();

  const themeOrder = ['system', 'light', 'dark'];
  const currentTheme = $derived($settings.theme || 'system');
  const themeMeta = $derived(getThemeMeta(currentTheme));

  function cycleTheme() {
    const idx = themeOrder.indexOf(currentTheme);
    const next = themeOrder[(idx + 1) % themeOrder.length];
    updateSetting('theme', next);
  }

  function getThemeMeta(theme) {
    if (theme === 'light') return { label: 'Light', next: 'Dark' };
    if (theme === 'dark') return { label: 'Dark', next: 'System' };
    return { label: 'System', next: 'Light' };
  }

  function handleClose(e, tabId) {
    e.stopPropagation();
    const closedPath = closeTab(tabId);
    if (closedPath) onTabClose?.(closedPath);
  }
</script>

<div class="tab-bar">
  <div class="tab-list" role="tablist">
    {#each $tabs as tab (tab.id)}
      <div
        class="tab"
        class:active={$activeTabId === tab.id}
        class:home={tab.type === 'home'}
        role="tab"
        tabindex="0"
        aria-selected={$activeTabId === tab.id}
        onclick={() => setActiveTab(tab.id)}
        onkeydown={(e) => e.key === 'Enter' && setActiveTab(tab.id)}
        title={tab.type === 'course' ? tab.path : undefined}
      >
        {#if tab.type === 'home'}
          <svg class="tab-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2 6.5L8 2l6 4.5V13a1 1 0 01-1 1H3a1 1 0 01-1-1V6.5z" />
            <path d="M6 14V9h4v5" />
          </svg>
        {/if}
        <span class="tab-label">{tab.title}</span>
        {#if tab.type === 'course'}
          <button
            class="tab-close"
            onclick={(e) => handleClose(e, tab.id)}
            title="Close tab"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </button>
        {/if}
      </div>
    {/each}
  </div>
  <div class="tab-actions">
    <button
      class="tab-action-btn"
      onclick={cycleTheme}
      title={`Theme: ${themeMeta.label} (switch to ${themeMeta.next})`}
      data-testid="theme-toggle-btn"
    >
      {#if currentTheme === 'light'}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="1.8"/>
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
      {:else if currentTheme === 'dark'}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      {:else}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <rect x="3" y="4" width="18" height="12" rx="2" stroke="currentColor" stroke-width="1.8"/>
          <path d="M8 20h8M12 16v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
      {/if}
    </button>
    <button
      class="tab-action-btn"
      onclick={onOpenSettings}
      title="Settings"
      data-testid="settings-btn"
    >
      <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
        <path d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" stroke="currentColor" stroke-width="1.5"/>
        <path d="M16.17 12.5a1.39 1.39 0 00.28 1.53l.05.05a1.69 1.69 0 11-2.39 2.39l-.05-.05a1.39 1.39 0 00-1.53-.28 1.39 1.39 0 00-.84 1.27v.14a1.69 1.69 0 11-3.38 0v-.08a1.39 1.39 0 00-.91-1.27 1.39 1.39 0 00-1.53.28l-.05.05a1.69 1.69 0 11-2.39-2.39l.05-.05a1.39 1.39 0 00.28-1.53 1.39 1.39 0 00-1.27-.84h-.14a1.69 1.69 0 110-3.38h.08a1.39 1.39 0 001.27-.91 1.39 1.39 0 00-.28-1.53l-.05-.05a1.69 1.69 0 112.39-2.39l.05.05a1.39 1.39 0 001.53.28h.07a1.39 1.39 0 00.84-1.27v-.14a1.69 1.69 0 113.38 0v.08a1.39 1.39 0 00.84 1.27 1.39 1.39 0 001.53-.28l.05-.05a1.69 1.69 0 112.39 2.39l-.05.05a1.39 1.39 0 00-.28 1.53v.07a1.39 1.39 0 001.27.84h.14a1.69 1.69 0 010 3.38h-.08a1.39 1.39 0 00-1.27.84z" stroke="currentColor" stroke-width="1.5"/>
      </svg>
    </button>
  </div>
</div>

<style>
  .tab-bar {
    display: flex;
    align-items: stretch;
    background: color-mix(in srgb, var(--bg-primary) 92%, var(--bg-elevated));
    border-bottom: 1px solid var(--border);
    padding: 0 var(--sp-md);
    width: 100%;
    flex: 1;
    min-width: 0;
    flex-shrink: 0;
    overflow: hidden;
    -webkit-app-region: no-drag;
    height: 100%;
  }

  .tab-list {
    display: flex;
    align-items: stretch;
    gap: 1px;
    flex: 1;
    min-width: 0;
    overflow-x: auto;
  }

  /* When inside the titlebar, drop the border — the titlebar owns the region */
  :global(.titlebar-drag) .tab-bar {
    border-bottom: none;
  }

  .tab-list::-webkit-scrollbar {
    display: none;
  }

  .tab {
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
    padding: 8px 12px;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-tertiary);
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    max-width: 200px;
    transition: all var(--duration-fast) var(--ease);
    border-radius: var(--radius-md) var(--radius-md) 0 0;
    margin-top: 2px;
  }

  .tab:hover {
    color: var(--text-secondary);
    background: color-mix(in srgb, var(--bg-secondary) 74%, transparent);
  }

  .tab.active {
    color: var(--text-primary);
    border-bottom-color: var(--accent);
    background: var(--bg-elevated);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.22);
  }

  .tab.home {
    padding-left: 12px;
    padding-right: 12px;
  }

  .tab-icon {
    flex-shrink: 0;
  }

  .tab-label {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tab-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: var(--radius-sm);
    background: transparent;
    border: none;
    color: var(--text-tertiary);
    cursor: pointer;
    padding: 0;
    flex-shrink: 0;
    opacity: 0.5;
    transition: all var(--duration-fast) var(--ease);
  }

  .tab:hover .tab-close {
    opacity: 1;
  }

  .tab-close:hover {
    background: var(--error-subtle);
    color: var(--error);
    transform: scale(1.05);
  }

  .tab-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    padding-left: var(--sp-sm);
    margin-left: var(--sp-sm);
  }

  .tab-action-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--bg-elevated) 74%, transparent);
    color: var(--text-secondary);
    cursor: pointer;
    transition: all var(--duration-fast) var(--ease);
  }

  .tab-action-btn:hover {
    color: var(--text-primary);
    background: var(--bg-secondary);
    border-color: var(--border-strong);
  }

  .tab-action-btn:active {
    transform: scale(0.96);
  }

  @media (prefers-reduced-motion: reduce) {
    .tab:hover,
    .tab-close:hover,
    .tab-action-btn:hover,
    .tab-action-btn:active {
      transform: none;
    }
  }

  @media (max-width: 880px) {
    .tab-bar {
      padding: 0 var(--sp-sm);
    }

    .tab {
      max-width: 150px;
      padding: 8px 10px;
    }

    .tab-actions {
      margin-left: var(--sp-xs);
      padding-left: var(--sp-xs);
    }
  }
</style>
