<script>
  import DeployProgress from './DeployProgress.svelte';

  let {
    active = false,
    stage = 'building',
    message = 'Preparing deployment...',
    targetLabel = 'Deploying to CourseCode Cloud',
    dashboardUrl = '',
    previewUrl = '',
    onclose
  } = $props();

  let copiedField = $state('');

  function canClose() {
    return !active;
  }

  function handleBackdropClick(e) {
    if (!canClose()) return;
    if (e.target === e.currentTarget) onclose?.();
  }

  function handleKeydown(e) {
    if (!canClose()) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      onclose?.();
    }
  }

  async function copyValue(value, field) {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    copiedField = field;
    setTimeout(() => {
      if (copiedField === field) copiedField = '';
    }, 1800);
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="deploy-dialog-backdrop"
  role="dialog"
  aria-modal="true"
  aria-labelledby="deploy-progress-title"
  tabindex="-1"
  onkeydown={handleKeydown}
  onclick={handleBackdropClick}
>
  <div class="deploy-dialog">
    <div class="deploy-dialog-header">
      <div>
        <h3 id="deploy-progress-title">Deployment Status</h3>
        <p>{active ? 'This window stays open until deployment finishes.' : 'Deployment finished. Review the result, then close this window.'}</p>
      </div>
      {#if canClose()}
        <button class="deploy-dialog-close" onclick={() => onclose?.()} aria-label="Close deployment status">
          ×
        </button>
      {/if}
    </div>

    <DeployProgress {active} {stage} {message} {targetLabel} />

    {#if !active && (dashboardUrl || previewUrl)}
      <div class="deploy-links">
        {#if dashboardUrl}
          <div class="deploy-link-card">
            <div class="deploy-link-copy">
              <span class="deploy-link-label">Course Page</span>
              <code>{dashboardUrl}</code>
            </div>
            <div class="deploy-link-actions">
              <button class="btn-secondary btn-sm" onclick={() => copyValue(dashboardUrl, 'dashboard')}>
                {copiedField === 'dashboard' ? 'Copied' : 'Copy'}
              </button>
              <button class="btn-secondary btn-sm" onclick={() => window.open(dashboardUrl)}>Open</button>
            </div>
          </div>
        {/if}

        {#if previewUrl}
          <div class="deploy-link-card">
            <div class="deploy-link-copy">
              <span class="deploy-link-label">Preview URL</span>
              <code>{previewUrl}</code>
            </div>
            <div class="deploy-link-actions">
              <button class="btn-secondary btn-sm" onclick={() => copyValue(previewUrl, 'preview')}>
                {copiedField === 'preview' ? 'Copied' : 'Copy'}
              </button>
              <button class="btn-secondary btn-sm" onclick={() => window.open(previewUrl)}>Open</button>
            </div>
          </div>
        {/if}
      </div>
    {/if}

    <div class="deploy-dialog-actions">
      <button class="btn-primary" disabled={!canClose()} onclick={() => onclose?.()}>
        {canClose() ? 'Close' : 'Deploying...'}
      </button>
    </div>
  </div>
</div>

<style>
  .deploy-dialog-backdrop {
    position: fixed;
    inset: 0;
    z-index: 10010;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: var(--bg-overlay);
    backdrop-filter: blur(4px);
  }

  .deploy-dialog {
    width: min(520px, calc(100vw - 48px));
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 20px;
    border-radius: var(--radius-lg);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    box-shadow: var(--shadow-lg);
  }

  .deploy-dialog-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
  }

  h3 {
    margin: 0;
    font-size: var(--text-lg);
  }

  p {
    margin: 4px 0 0;
    color: var(--text-secondary);
    font-size: var(--text-sm);
    line-height: 1.45;
  }

  .deploy-dialog-close {
    width: 32px;
    height: 32px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-pill);
    color: var(--text-tertiary);
    background: var(--bg-secondary);
    font-size: 20px;
    line-height: 1;
  }

  .deploy-dialog-close:hover {
    color: var(--text-primary);
    background: color-mix(in srgb, var(--bg-secondary) 70%, var(--border));
  }

  .deploy-dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
  }

  .deploy-dialog-actions button {
    min-width: 124px;
  }

  .deploy-links {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .deploy-link-card {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 12px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-secondary);
  }

  .deploy-link-copy {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    flex: 1;
  }

  .deploy-link-label {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-tertiary);
  }

  code {
    display: block;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--bg-elevated) 72%, transparent);
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  .deploy-link-actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }

  @media (max-width: 640px) {
    .deploy-link-card {
      flex-direction: column;
      align-items: stretch;
    }

    .deploy-link-actions {
      justify-content: flex-end;
    }
  }
</style>
