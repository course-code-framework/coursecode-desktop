<script>
  let { name, description, status, version = null, actionLabel = null, onAction = null } = $props();

  const statusConfig = {
    'installed-configured': { icon: '✅', label: 'Ready' },
    'installed-not-configured': { icon: '⚙️', label: 'Needs Setup' },
    'not-installed': { icon: '⬇️', label: 'Not Installed' }
  };

  const config = $derived(statusConfig[status] || statusConfig['not-installed']);
</script>

<div class="tool-card" class:configured={status === 'installed-configured'}>
  <div class="tool-header">
    <span class="tool-icon">{config.icon}</span>
    <div class="tool-info">
      <span class="tool-name">{name}</span>
      {#if version}
        <span class="tool-version">v{version}</span>
      {/if}
    </div>
  </div>
  <p class="tool-desc">{description}</p>
  <div class="tool-footer">
    <span class="tool-status">{config.label}</span>
    {#if actionLabel && onAction}
      <button class="btn-ghost text-sm" onclick={onAction}>{actionLabel}</button>
    {/if}
  </div>
</div>

<style>
  .tool-card {
    padding: var(--sp-md);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-primary);
    display: flex;
    flex-direction: column;
    gap: var(--sp-sm);
    transition: border-color var(--duration-fast) var(--ease);
  }

  .tool-card.configured {
    border-color: var(--success);
    border-color: color-mix(in srgb, var(--success) 30%, transparent);
  }

  .tool-header {
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
  }

  .tool-icon {
    font-size: var(--text-lg);
  }

  .tool-info {
    display: flex;
    align-items: baseline;
    gap: var(--sp-xs);
  }

  .tool-name {
    font-weight: 600;
    font-size: var(--text-sm);
  }

  .tool-version {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    font-family: var(--font-mono);
  }

  .tool-desc {
    font-size: var(--text-sm);
    color: var(--text-secondary);
    line-height: 1.4;
  }

  .tool-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: auto;
    padding-top: var(--sp-sm);
  }

  .tool-status {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    font-weight: 500;
  }
</style>
