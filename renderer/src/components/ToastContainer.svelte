<script>
  import { toasts, dismissToast } from '../stores/toast.js';
  import Icon from './Icon.svelte';
</script>

{#if $toasts.length > 0}
  <div class="toast-container" aria-live="polite">
    {#each $toasts as toast (toast.id)}
      <div class="toast toast-{toast.type}" role="status" data-testid="toast">
        <div class="toast-body">
          <div class="toast-icon">
            {#if toast.type === 'success'}
              <Icon size={16}><path d="M20 6 9 17l-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></Icon>
            {:else if toast.type === 'error'}
              <Icon size={16}><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></Icon>
            {:else if toast.type === 'warning'}
              <Icon size={16}><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></Icon>
            {:else}
              <Icon size={16}><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></Icon>
            {/if}
          </div>
          <span class="toast-message">{toast.message}</span>
        </div>
        <div class="toast-actions">
          {#if toast.action}
            <button class="toast-action-btn" onclick={() => { toast.action.handler(); dismissToast(toast.id); }}>
              {toast.action.label}
            </button>
          {/if}
          <button class="toast-dismiss" onclick={() => dismissToast(toast.id)} title="Dismiss" aria-label="Dismiss">
            <Icon size={14}><path d="M18 6 6 18"/><path d="m6 6 12 12"/></Icon>
          </button>
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  .toast-container {
    position: fixed;
    bottom: var(--sp-lg);
    right: var(--sp-lg);
    z-index: 9999;
    display: flex;
    flex-direction: column-reverse;
    gap: var(--sp-sm);
    max-width: 420px;
    pointer-events: none;
  }

  .toast {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-sm);
    padding: var(--sp-sm) var(--sp-md);
    border-radius: var(--radius-md);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    box-shadow: var(--shadow-lg);
    pointer-events: auto;
    animation: toastSlideIn 220ms var(--ease);
    min-height: 40px;
  }

  .toast-body {
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
    min-width: 0;
  }

  .toast-icon {
    flex-shrink: 0;
    display: flex;
    align-items: center;
  }

  .toast-success .toast-icon { color: var(--success); }
  .toast-error .toast-icon { color: var(--error); }
  .toast-warning .toast-icon { color: var(--warning); }
  .toast-info .toast-icon { color: var(--info); }

  .toast-message {
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text-primary);
    line-height: 1.4;
  }

  .toast-actions {
    display: flex;
    align-items: center;
    gap: var(--sp-xs);
    flex-shrink: 0;
  }

  .toast-action-btn {
    padding: 3px 10px;
    border-radius: var(--radius-sm);
    background: var(--accent-subtle);
    color: var(--accent);
    font-size: var(--text-xs);
    font-weight: 600;
    cursor: pointer;
    border: none;
    white-space: nowrap;
    transition: background var(--duration-fast) var(--ease);
  }

  .toast-action-btn:hover {
    background: var(--accent);
    color: var(--text-on-accent);
  }

  .toast-dismiss {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: var(--radius-sm);
    background: none;
    border: none;
    color: var(--text-tertiary);
    cursor: pointer;
    transition: all var(--duration-fast) var(--ease);
  }

  .toast-dismiss:hover {
    background: var(--bg-secondary);
    color: var(--text-secondary);
  }

  @keyframes toastSlideIn {
    from { opacity: 0; transform: translateY(8px) scale(0.97); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
</style>
