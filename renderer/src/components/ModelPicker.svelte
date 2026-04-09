<script>
  import { onMount } from 'svelte';
  import { settings, updateSetting } from '../stores/settings.js';
  import { aiMode, loadCredits } from '../stores/chat.js';
  import { user, cloudReady } from '../stores/auth.js';

  let { onClose } = $props();

  let providers = $state([]);
  let cloudModels = $state([]);
  let cloudLoading = $state(false);
  let open = $state(false);

  let configuredProviders = $derived(providers.filter(p => p.hasKey));
  let hasAnyKey = $derived(configuredProviders.length > 0);

  onMount(async () => {
    await refreshAvailableModels();
  });

  $effect(() => {
    if (open) {
      refreshAvailableModels();
    }
  });

  async function refreshAvailableModels() {
    providers = await window.api.ai.getProviders();
    if ($cloudReady) {
      await fetchCloudModels();
    }
  }

  async function fetchCloudModels() {
    cloudLoading = true;
    try {
      const result = await window.api.ai.getCloudModels();
      cloudModels = result || [];
      await loadCredits();
    } catch {
      cloudModels = [];
    }
    cloudLoading = false;
  }

  function getSelectedLabel() {
    if ($aiMode === 'cloud') {
      const model = cloudModels.find(m => m.id === $settings.cloudAiModel);
      return model?.name || $settings.cloudAiModel || 'Cloud AI';
    }
    const provider = providers.find(p => p.id === $settings.aiProvider);
    const model = provider?.models?.find(m => m.id === $settings.aiModel);
    const fallback = provider?.models?.find(m => m.default) || provider?.models?.[0];
    return model?.label || fallback?.label || 'Select model';
  }

  function selectByokModel(providerId, modelId) {
    updateSetting('aiProvider', providerId);
    updateSetting('aiModel', modelId);
    updateSetting('defaultAiMode', 'byok');
    updateSetting('aiModeInitialized', true);
    aiMode.set('byok');
    open = false;
    onClose?.();
  }

  function selectCloudModel(modelId) {
    updateSetting('cloudAiModel', modelId);
    updateSetting('defaultAiMode', 'cloud');
    updateSetting('aiModeInitialized', true);
    aiMode.set('cloud');
    open = false;
    onClose?.();
  }

  function handleClickOutside() {
    if (open) open = false;
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

  function cloudCostScore(m) {
    return (m.inputCreditsPerK ?? 0) + (m.outputCreditsPerK ?? 0);
  }

  function getCloudCostTier(model) {
    const allCosts = cloudModels.map(cloudCostScore);
    return getCostTier(cloudCostScore(model), allCosts);
  }
</script>

<div class="model-picker">
  <button class="picker-trigger" onclick={() => open = !open}>
    {#if $aiMode === 'cloud'}
      <span class="mode-dot cloud"></span>
    {:else}
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path d="M6 1v10M1 6h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    {/if}
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
          <span class="setup-badge">Set up →</span>
        {/if}
      </div>
      {#if hasAnyKey}
        {#each configuredProviders as provider}
          <div class="provider-group">
            <div class="provider-name">{provider.name}</div>
            {#if provider.modelFetchFailed && provider.models.length === 0}
              <div class="cloud-gate">
                <span class="gate-text">Could not load models</span>
              </div>
            {/if}
            {#each provider.models as model}
              <button
                class="model-option"
                class:selected={$aiMode === 'byok' && $settings.aiModel === model.id}
                onclick={() => selectByokModel(provider.id, model.id)}
              >
                <span class="model-name">{model.label}</span>
                <span class="cost-tier">{getByokCostTier(model)}</span>
                {#if model.default}
                  <span class="default-badge">default</span>
                {/if}
                {#if $aiMode === 'byok' && $settings.aiModel === model.id}
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M3 7l3 3 5-5.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                {/if}
              </button>
            {/each}
          </div>
        {/each}
      {/if}

      <!-- Cloud models -->
      <div class="section-label cloud-label">
        CourseCode Cloud
      </div>
      {#if !$cloudReady}
        <div class="cloud-gate">
          <span class="gate-text">Sign in to use</span>
        </div>
      {:else if cloudLoading}
        <div class="cloud-gate">
          <span class="spinner-sm"></span>
        </div>
      {:else if cloudModels.length === 0}
        <div class="cloud-gate">
          <span class="gate-text">No models available</span>
        </div>
      {:else}
        <div class="provider-group">
          {#each cloudModels as model}
            <button
              class="model-option"
              class:selected={$aiMode === 'cloud' && $settings.cloudAiModel === model.id}
              onclick={() => selectCloudModel(model.id)}
            >
              <span class="model-name">{model.name || model.id}</span>
              <span class="cost-tier">{getCloudCostTier(model)}</span>
              {#if $aiMode === 'cloud' && $settings.cloudAiModel === model.id}
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M3 7l3 3 5-5.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

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

  .mode-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .mode-dot.cloud {
    background: var(--accent);
    box-shadow: 0 0 4px var(--accent);
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

  .cloud-label {
    background: var(--accent-subtle);
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
    color: var(--accent);
    font-weight: 500;
    text-transform: none;
    letter-spacing: normal;
    cursor: pointer;
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

  .cloud-gate {
    padding: var(--sp-sm) var(--sp-md) var(--sp-md);
    text-align: center;
  }

  .gate-text {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }

  .spinner-sm {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
