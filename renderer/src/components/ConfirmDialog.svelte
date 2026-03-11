<script>
  /** @type {{ title?: string, message: string, detail?: string, confirmLabel?: string, cancelLabel?: string, alternateLabel?: string, destructive?: boolean }} */
  let {
    title = 'Confirm',
    message,
    detail = '',
    confirmLabel = 'OK',
    cancelLabel = 'Cancel',
    alternateLabel = '',
    destructive = false,
    onconfirm,
    onalternate,
    oncancel
  } = $props();

  let dialogEl = $state(null);

  function handleKeydown(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      oncancel?.();
    }
  }

  function handleBackdropClick(e) {
    if (e.target === e.currentTarget) oncancel?.();
  }

  $effect(() => {
    if (dialogEl) {
      const btn = dialogEl.querySelector('[data-autofocus]');
      btn?.focus();
    }
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="confirm-backdrop" role="dialog" aria-modal="true" aria-labelledby="confirm-title"
     tabindex="-1" onkeydown={handleKeydown} onclick={handleBackdropClick}>
  <div class="confirm-dialog" bind:this={dialogEl}>
    {#if title}
      <h3 id="confirm-title" class="confirm-title">{title}</h3>
    {/if}
    <p class="confirm-message">{message}</p>
    {#if detail}
      <p class="confirm-detail">{detail}</p>
    {/if}
    <div class="confirm-actions">
      <button class="btn-secondary" onclick={() => oncancel?.()}>
        {cancelLabel}
      </button>
      {#if alternateLabel}
        <button class="btn-secondary" onclick={() => onalternate?.()}>
          {alternateLabel}
        </button>
      {/if}
      <button
        class={destructive ? 'btn-danger' : 'btn-primary'}
        data-autofocus
        onclick={() => onconfirm?.()}
      >
        {confirmLabel}
      </button>
    </div>
  </div>
</div>

<style>
  .confirm-backdrop {
    position: fixed;
    inset: 0;
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-overlay);
    backdrop-filter: blur(4px);
    animation: fadeIn 120ms ease-out;
  }

  .confirm-dialog {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: var(--sp-lg);
    width: 400px;
    max-width: calc(100vw - 48px);
    box-shadow: var(--shadow-lg);
    animation: scaleIn 150ms ease-out;
  }

  .confirm-title {
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: var(--sp-sm);
  }

  .confirm-message {
    font-size: var(--text-base);
    color: var(--text-primary);
    line-height: 1.5;
  }

  .confirm-detail {
    font-size: var(--text-sm);
    color: var(--text-secondary);
    margin-top: var(--sp-xs);
    line-height: 1.5;
  }

  .confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--sp-sm);
    margin-top: var(--sp-lg);
  }

  .confirm-actions button {
    padding: var(--sp-sm) var(--sp-md);
    font-size: var(--text-sm);
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @keyframes scaleIn {
    from { opacity: 0; transform: scale(0.95); }
    to { opacity: 1; transform: scale(1); }
  }
</style>
