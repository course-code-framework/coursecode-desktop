<script>
  import { onMount } from 'svelte';
  import { settings, updateSetting } from '../stores/settings.js';
  import ConfirmDialog from './ConfirmDialog.svelte';

  let { onClose } = $props();

  const isMac = navigator.platform.includes('Mac');
  let providers = $state([]);
  let open = $state(false);
  let refreshedWhileOpen = $state(false);
  let keychainNotice = $state(false);
  let keychainNoticeResolve = null;

  let configuredProviders = $derived(providers.filter(p => p.hasKey));
  let hasAnyKey = $derived(configuredProviders.length > 0);

  onMount(async () => {
    providers = await window.api.ai.getProviders();
  });

  $effect(() => {
    if (open && !refreshedWhileOpen) {
      refreshedWhileOpen = true;
      refreshAvailableModels();
    } else if (!open) {
      refreshedWhileOpen = false;
    }
  });

  function showKeychainNotice() {
    if (!isMac || !hasAnyKey) return Promise.resolve(true);
    return new Promise((resolve) => {
      keychainNoticeResolve = resolve;
      keychainNotice = true;
    });
  }

  function closeKeychainNotice(confirmed) {
    keychainNotice = false;
    keychainNoticeResolve?.(confirmed);
    keychainNoticeResolve = null;
  }

  async function refreshAvailableModels() {
    const confirmed = await showKeychainNotice();
    if (!confirmed) return;

    providers = await window.api.ai.getProviders({ includeModels: true });
  }

  function getSelectedLabel() {
    const provider = providers.find(p => p.id === $settings.aiProvider);
    const model = provider?.models?.find(m => m.id === $settings.aiModel);
    const fallback = provider?.models?.find(m => m.default) || provider?.models?.[0];
    return model?.label || fallback?.label || $settings.aiModel || 'Select model';
  }

  function selectByokModel(providerId, modelId) {
    updateSetting('aiProvider', providerId);
    updateSetting('aiModel', modelId);
    open = false;
    onClose?.();
  }

  function handleClickOutside() {
    if (open) open = false;
  }

  function openSettings() {
    open = false;
    document.dispatchEvent(new CustomEvent('open-settings'));
    onClose?.();
  }

  /** Compute $ tier for a cost value relative to the cheapest in the group */
  function getCostTier(cost, allCosts) {
    const valid = allCosts.filter(c => c != null && c > 0);
    if (!valid.length || cost == null) return '';
    const min = Math.min(...valid);
    const ratio = cost / min;
    if (ratio <= 1.5) return '$';
    if (ratio <= 4) return '$$';
    if (ratio <= 8) return '$$$';
    return '$$$$';
  }

  function getByokCostTier(model) {
    const allScores = configuredProviders.flatMap(p => p.models.map(m => m.costScore));
    return getCostTier(model.costScore, allScores);
  }
</script>

<div class="model-picker">
  <button class="picker-trigger" onclick={() => open = !open}>
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M6 1v10M1 6h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
    <span class="model-label">{getSelectedLabel()}</span>
    <svg class="chevron" class:open width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M2 4l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </button>

  {#if open}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="picker-backdrop" onclick={handleClickOutside}></div>
    <div class="picker-dropdown">
      <!-- BYOK providers -->
      <div class="section-label">
        Your Keys
        {#if !hasAnyKey}
          <button type="button" class="setup-badge" onclick={openSettings}>Set up →</button>
        {/if}
      </div>
      {#if hasAnyKey}
        {#each configuredProviders as provider}
          <div class="provider-group">
            <div class="provider-name">{provider.name}</div>
            {#if provider.modelFetchFailed && provider.models.length === 0}
              <div class="model-gate">
                <span class="gate-text">Could not load models</span>
              </div>
            {/if}
            {#each provider.models as model}
              <button
                class="model-option"
                class:selected={$settings.aiModel === model.id}
                onclick={() => selectByokModel(provider.id, model.id)}
              >
                <span class="model-name">{model.label}</span>
                <span class="cost-tier">{getByokCostTier(model)}</span>
                {#if model.default}
                  <span class="default-badge">default</span>
                {/if}
                {#if $settings.aiModel === model.id}
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M3 7l3 3 5-5.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                {/if}
              </button>
            {/each}
          </div>
        {/each}
      {/if}

    </div>
  {/if}
</div>

{#if keychainNotice}
  <ConfirmDialog
    title="macOS Keychain Access"
    message="macOS may ask CourseCode to use Keychain."
    detail="CourseCode needs to decrypt your saved API key locally to refresh provider models or use your selected AI provider."
    confirmLabel="Continue"
    cancelLabel="Cancel"
    onconfirm={() => closeKeychainNotice(true)}
    oncancel={() => closeKeychainNotice(false)}
  />
{/if}

<style>
  .model-picker {
    position: relative;
  }

  .picker-trigger {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    background: color-mix(in srgb, var(--bg-elevated) 74%, transparent);
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    color: var(--text-tertiary);
    font-size: var(--text-xs);
    cursor: pointer;
    transition: all var(--duration-fast) var(--ease);
  }

  .picker-trigger:hover {
    background: var(--bg-secondary);
    border-color: var(--border-strong);
    color: var(--text-secondary);
  }

  .chevron {
    transition: transform var(--duration-fast) var(--ease);
  }

  .chevron.open {
    transform: rotate(180deg);
  }

  .picker-backdrop {
    position: fixed;
    inset: 0;
    z-index: 49;
  }

  .picker-dropdown {
    position: absolute;
    bottom: 100%;
    left: 0;
    min-width: 240px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    margin-bottom: var(--sp-xs);
    z-index: 50;
    overflow: hidden;
    animation: slideUp 0.15s var(--ease);
  }

  @keyframes slideUp {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .section-label {
    padding: var(--sp-sm) var(--sp-md) var(--sp-xs);
    font-size: 10px;
    font-weight: 700;
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-top: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .section-label:first-child {
    border-top: none;
  }

  .provider-group {
    padding: var(--sp-xs) 0;
  }

  .provider-name {
    padding: 0 var(--sp-md) var(--sp-xs);
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--text-tertiary);
  }

  .setup-badge {
    border: none;
    background: none;
    color: var(--accent);
    font-weight: 500;
    text-transform: none;
    letter-spacing: normal;
    cursor: pointer;
    padding: 0;
  }

  .model-option {
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
    width: 100%;
    padding: var(--sp-sm) var(--sp-md);
    background: none;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: var(--text-sm);
    cursor: pointer;
    text-align: left;
    transition: background var(--duration-fast) var(--ease);
  }

  .model-option:hover:not(:disabled) {
    background: var(--accent-subtle);
  }

  .model-option.selected {
    color: var(--accent);
    font-weight: 500;
    background: color-mix(in srgb, var(--accent-subtle) 72%, transparent);
  }

  .model-option:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .model-name {
    flex: 1;
  }

  .default-badge {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: var(--radius-pill);
    background: var(--accent-subtle);
    color: var(--accent);
    font-weight: 500;
  }

  .cost-tier {
    font-size: 10px;
    color: var(--text-tertiary);
    font-weight: 500;
    letter-spacing: -0.5px;
  }

  .model-label {
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .model-gate {
    padding: var(--sp-sm) var(--sp-md) var(--sp-md);
    text-align: center;
  }

  .gate-text {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }
</style>
