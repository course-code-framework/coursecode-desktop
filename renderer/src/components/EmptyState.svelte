<script>
  let { title, description, actionLabel, onAction } = $props();
</script>

<div class="empty-state">
  <div class="empty-icon">
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
      <rect x="8" y="12" width="48" height="40" rx="4" stroke="currentColor" stroke-width="2"/>
      <path d="M8 24h48" stroke="currentColor" stroke-width="2"/>
      <circle cx="16" cy="18" r="2" fill="currentColor"/>
      <circle cx="22" cy="18" r="2" fill="currentColor"/>
      <circle cx="28" cy="18" r="2" fill="currentColor"/>
      <path d="M24 36l6-6 6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M30 30v14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>
  </div>
  <h2 class="empty-title">{title}</h2>
  <p class="empty-description">{description}</p>
  {#if actionLabel && onAction}
    <button class="btn-primary btn-lg" onclick={onAction}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
      {actionLabel}
    </button>
  {/if}
</div>

<style>
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: var(--sp-2xl);
    min-height: 400px;
    gap: var(--sp-lg);
  }

  .empty-icon {
    color: var(--text-tertiary);
    opacity: 0.6;
  }

  .empty-title {
    color: var(--text-primary);
  }

  .empty-description {
    color: var(--text-secondary);
    max-width: 400px;
    line-height: 1.6;
  }
</style>
