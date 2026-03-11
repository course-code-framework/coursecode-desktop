<script>
  import { onMount, onDestroy } from 'svelte';
  import { settings, updateSetting } from '../stores/settings.js';
  import { user, login, logout, cloudReady, loginError } from '../stores/auth.js';
  import { credits, loadCredits } from '../stores/chat.js';
  import { showToast } from '../stores/toast.js';
  import ToolCard from '../components/ToolCard.svelte';

  let signingIn = $state(false);
  let deviceStage = $state(null); // null | 'requesting' | 'device' | 'approved' | 'complete' | 'error'
  let deviceUserCode = $state(null);
  let deviceVerificationUri = $state(null);
  let deviceErrorMessage = $state(null);
  let unsubLogin = null;

  let { onBack, onRunSetup } = $props();

  let setupStatus = $state(null);
  let appVersion = $state('');
  let aiProviders = $state([]);
  let cloudModels = $state([]);
  let aiConfig = $state({});
  let apiKeyInput = $state('');
  let savingKey = $state(false);
  let keyError = $state('');
  let keySuccess = $state('');
  let updateStatus = $state(null);
  let checkingUpdates = $state(false);
  let refreshingModels = $state(false);
  let cloudProviderFilter = $state('all');
  let cloudModelLoadError = $state('');
  let attemptedCloudRefresh = $state(false);
  let unsubUpdateStatus = null;

  let aiMode = $derived(($settings.defaultAiMode || 'byok'));
  let selectedByokProvider = $derived(aiProviders.find(p => p.id === ($settings.aiProvider || 'anthropic')));
  let cachedCloudModels = $derived(Array.isArray($settings.cloudModelCache) ? $settings.cloudModelCache : []);
  let effectiveCloudModels = $derived((cloudModels && cloudModels.length > 0) ? cloudModels : cachedCloudModels);

  function cloudModelProvider(model) {
    if (model.provider) return String(model.provider).toLowerCase();
    if (model.vendor) return String(model.vendor).toLowerCase();
    const id = String(model.id || '').toLowerCase();
    if (id.startsWith('claude')) return 'anthropic';
    if (id.startsWith('gpt') || /^o\d/.test(id)) return 'openai';
    return 'other';
  }

  let cloudProviderOptions = $derived([
    { value: 'all', label: 'All Providers' },
    ...(Array.from(new Set(effectiveCloudModels.map(cloudModelProvider))).includes('anthropic')
      ? [{ value: 'anthropic', label: 'Anthropic' }]
      : []),
    ...(Array.from(new Set(effectiveCloudModels.map(cloudModelProvider))).includes('openai')
      ? [{ value: 'openai', label: 'OpenAI' }]
      : [])
  ]);

  let filteredCloudModels = $derived(
    cloudProviderFilter === 'all'
      ? effectiveCloudModels
      : effectiveCloudModels.filter(m => cloudModelProvider(m) === cloudProviderFilter)
  );

  $effect(() => {
    if (aiMode !== 'cloud' || !$cloudReady) {
      attemptedCloudRefresh = false;
      return;
    }
    if (effectiveCloudModels.length > 0 || refreshingModels || attemptedCloudRefresh) return;
    attemptedCloudRefresh = true;
    refreshAvailableModels();
  });

  $effect(() => {
    if (cloudProviderFilter === 'all') return;
    if (effectiveCloudModels.length === 0) return;
    if (filteredCloudModels.length > 0) return;
    cloudProviderFilter = 'all';
  });

  onMount(async () => {
    setupStatus = await window.api.setup.getStatus();
    appVersion = await window.api.app.getVersion();
    updateStatus = await window.api.app.getUpdateStatus();
    await refreshAvailableModels();

    unsubUpdateStatus = window.api.app.onUpdateStatus((status) => {
      updateStatus = status;
      checkingUpdates = status?.state === 'checking';
    });
    if ($cloudReady) {
      await loadCredits();
    }
  });

  onDestroy(() => {
    unsubUpdateStatus?.();
    unsubLogin?.();
  });

  async function startLogin() {
    signingIn = true;
    deviceStage = 'requesting';
    deviceErrorMessage = null;

    unsubLogin = window.api.cloud.onLoginProgress((data) => {
      if (data.stage === 'device') {
        deviceStage = 'device';
        deviceUserCode = data.userCode;
        deviceVerificationUri = data.verificationUri;
      } else if (data.stage === 'approved') {
        deviceStage = 'approved';
      } else if (data.stage === 'complete') {
        deviceStage = null;
        signingIn = false;
        unsubLogin?.();
      } else if (data.stage === 'error') {
        deviceStage = 'error';
        deviceErrorMessage = data.message || 'Sign in failed. Please try again.';
        signingIn = false;
        unsubLogin?.();
      }
    });

    try {
      await login();
    } catch {
      // error already handled via loginProgress events
    } finally {
      signingIn = false;
    }
  }

  async function browseFolder() {
    try {
      const result = await window.api.dialog.pickFolder();
      if (result) {
        await updateSetting('projectsDir', result);
        showToast({ type: 'success', message: 'Projects directory updated.', duration: 3000 });
      }
    } catch (err) {
      showToast({ type: 'error', message: `Failed to set directory: ${err.message}` });
    }
  }

  function setTheme(theme) {
    updateSetting('theme', theme);
  }

  function setDefaultAiMode(mode) {
    updateSetting('defaultAiMode', mode);
    updateSetting('aiModeInitialized', true);
  }

  async function setAiProvider(provider) {
    await window.api.ai.setProvider(provider);
    // Set default model for the provider
    const p = aiProviders.find(pp => pp.id === provider);
    const defaultModel = p?.models?.find(m => m.default) || p?.models?.[0];
    if (defaultModel) {
      await window.api.ai.setModel(defaultModel.id);
      updateSetting('aiModel', defaultModel.id);
    }
    updateSetting('aiProvider', provider);
    aiConfig = await window.api.ai.getConfig();
    apiKeyInput = '';
    keyError = '';
    keySuccess = '';
  }

  async function refreshAvailableModels() {
    refreshingModels = true;
    cloudModelLoadError = '';
    try {
      aiProviders = await window.api.ai.getProviders();
      aiConfig = await window.api.ai.getConfig();
      if ($cloudReady) {
        try {
          const fetched = (await window.api.ai.getCloudModels()) || [];
          cloudModels = fetched;
          if (fetched.length > 0) {
            await updateSetting('cloudModelCache', fetched);
          }
        } catch (err) {
          cloudModels = [];
          cloudModelLoadError = err?.message || 'Could not refresh cloud models.';
        }
      } else {
        cloudModels = [];
      }

      const providerId = $settings.aiProvider || 'anthropic';
      const provider = aiProviders.find(p => p.id === providerId);
      const configuredModel = $settings.aiModel;
      const hasConfiguredModel = provider?.models?.some(m => m.id === configuredModel);
      if (provider?.models?.length && !hasConfiguredModel) {
        const fallbackModel = provider.models.find(m => m.default)?.id || provider.models[0].id;
        await window.api.ai.setModel(fallbackModel);
        updateSetting('aiModel', fallbackModel);
      }

      if ($cloudReady) {
        await loadCredits();
      }

      const selectedProvider = aiProviders.find(p => p.id === ($settings.aiProvider || 'anthropic'));
      if (selectedProvider?.hasKey && selectedProvider?.modelFetchFailed) {
        showToast({
          type: 'error',
          message: selectedProvider.modelFetchError || `Could not fetch models from ${selectedProvider.name}. Check API key permissions and network.`
        });
      }

      const configuredCloudModel = $settings.cloudAiModel;
      const hasConfiguredCloudModel = effectiveCloudModels.some(m => m.id === configuredCloudModel);
      if (effectiveCloudModels.length > 0 && !hasConfiguredCloudModel) {
        await updateSetting('cloudAiModel', effectiveCloudModels[0].id);
      }
    } catch (err) {
      showToast({ type: 'error', message: err?.message || 'Failed to refresh available models.' });
    } finally {
      refreshingModels = false;
    }
  }

  async function setAiModel(model) {
    await window.api.ai.setModel(model);
    updateSetting('aiModel', model);
  }

  async function saveApiKey() {
    if (!apiKeyInput.trim()) return;
    savingKey = true;
    keyError = '';
    keySuccess = '';
    try {
      const result = await window.api.ai.setApiKey($settings.aiProvider, apiKeyInput.trim());
      if (result.valid) {
        keySuccess = 'API key saved and verified!';
        apiKeyInput = '';
        await refreshAvailableModels();
      } else {
        keyError = result.error || 'Invalid API key';
      }
    } catch (err) {
      keyError = err.message;
    }
    savingKey = false;
  }

  async function removeKey() {
    await window.api.ai.removeApiKey($settings.aiProvider);
    await refreshAvailableModels();
    keySuccess = '';
  }

  async function saveCustomInstructions(e) {
    await window.api.ai.setCustomInstructions(e.target.value);
    updateSetting('aiCustomInstructions', e.target.value);
  }

  async function checkForUpdates() {
    checkingUpdates = true;
    try {
      updateStatus = await window.api.app.checkForUpdates();
    } finally {
      checkingUpdates = false;
    }
  }

  async function installUpdate() {
    await window.api.app.installUpdate();
  }

  function updateButtonLabel() {
    if (checkingUpdates || updateStatus?.state === 'checking') return 'Checking...';
    if (updateStatus?.state === 'downloaded') return 'Install and Restart';
    if (updateStatus?.state === 'downloading') return 'Downloading...';
    return 'Check for Updates';
  }
</script>

<div class="settings-view" data-testid="settings">
  <header class="settings-header">
    <button class="btn-icon btn-ghost" onclick={onBack} title="Back" data-testid="settings-back-btn">
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <path d="M12 4l-6 6 6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
    <h2>Settings</h2>
  </header>

  <div class="settings-content">
    <!-- General -->
    <section class="settings-section">
      <h3 class="section-title">General</h3>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">Projects Directory</span>
          <span class="setting-desc">Where CourseCode looks for your course projects.</span>
        </div>
        <div class="setting-control">
          <div class="path-row">
            <input type="text" value={$settings.projectsDir || ''} readonly class="path-input" />
            <button class="btn-secondary btn-sm" onclick={browseFolder}>Browse</button>
          </div>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">Default Format</span>
          <span class="setting-desc">Pre-selected when creating a new course.</span>
        </div>
        <div class="setting-control">
          <select value={$settings.defaultFormat || 'cmi5'} onchange={(e) => updateSetting('defaultFormat', e.target.value)}>
            <option value="cmi5">cmi5</option>
            <option value="scorm2004">SCORM 2004</option>
            <option value="scorm1.2">SCORM 1.2</option>
            <option value="lti">LTI</option>
          </select>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">Default Layout</span>
          <span class="setting-desc">Pre-selected when creating a new course.</span>
        </div>
        <div class="setting-control">
          <select value={$settings.defaultLayout || 'article'} onchange={(e) => updateSetting('defaultLayout', e.target.value)}>
            <option value="article">Article</option>
            <option value="traditional">Traditional</option>
            <option value="presentation">Presentation</option>
            <option value="focused">Focused</option>
            <option value="canvas">Canvas</option>
          </select>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">Show AI Chat by Default</span>
          <span class="setting-desc">When opening a course tab, start with the AI panel visible.</span>
        </div>
        <div class="setting-control">
          <label class="toggle-check">
            <input
              type="checkbox"
              checked={$settings.showAiChatByDefault !== false}
              onchange={(e) => updateSetting('showAiChatByDefault', e.target.checked)}
            />
            <span>Enabled</span>
          </label>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">Background Preview Servers</span>
          <span class="setting-desc">Keep preview servers running after you close a course tab.</span>
        </div>
        <div class="setting-control">
          <label class="toggle-check">
            <input
              type="checkbox"
              checked={$settings.keepPreviewRunningWithoutTab === true}
              onchange={(e) => updateSetting('keepPreviewRunningWithoutTab', e.target.checked)}
            />
            <span>Enabled</span>
          </label>
        </div>
      </div>
    </section>

    <!-- Appearance -->
    <section class="settings-section">
      <h3 class="section-title">Appearance</h3>
      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">Theme</span>
          <span class="setting-desc">Controls the app's color scheme.</span>
        </div>
        <div class="theme-buttons">
          {#each ['light', 'dark', 'system'] as t}
            <button
              class="theme-btn"
              class:active={($settings.theme || 'system') === t}
              onclick={() => setTheme(t)}
              data-testid={`theme-btn-${t}`}
            >
              {t === 'system' ? '💻 System' : t === 'light' ? '☀️ Light' : '🌙 Dark'}
            </button>
          {/each}
        </div>
      </div>
    </section>

    <!-- Tools & Integrations -->
    <section class="settings-section">
      <div class="section-header">
        <h3 class="section-title">Tools & Integrations</h3>
        <button class="btn-ghost text-sm" onclick={onRunSetup}>Run Setup Assistant</button>
      </div>

      {#if setupStatus}
        <div class="tools-grid">
          <ToolCard
            name="CourseCode CLI"
            description="Command-line tools for course building."
            status={setupStatus.cli?.state}
            version={setupStatus.cli?.version}
          />
          <ToolCard
            name="Version Control"
            description="Git & GitHub Desktop — track changes."
            status={setupStatus.git?.state}
          />
        </div>
      {/if}
    </section>

    <!-- AI Assistant -->
    <section class="settings-section">
      <h3 class="section-title">AI Assistant</h3>



      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">Default AI Mode</span>
          <span class="setting-desc">Choose how AI chat connects by default.</span>
        </div>
        <div class="setting-control">
          <div class="mode-toggle">
            <button
              class="mode-btn"
              class:active={$settings.defaultAiMode === 'cloud'}
              onclick={() => setDefaultAiMode('cloud')}
              disabled={!$cloudReady}
            >Cloud</button>
            <button
              class="mode-btn"
              class:active={($settings.defaultAiMode || 'byok') === 'byok'}
              onclick={() => setDefaultAiMode('byok')}
            >Your Key</button>
          </div>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">Provider</span>
          <span class="setting-desc">
            {#if aiMode === 'cloud'}
              Filter cloud models by provider.
            {:else}
              Choose your AI provider.
            {/if}
          </span>
        </div>
        <div class="setting-control">
          {#if aiMode === 'cloud'}
            <select value={cloudProviderFilter} onchange={(e) => cloudProviderFilter = e.target.value}>
              {#each cloudProviderOptions as p}
                <option value={p.value}>{p.label}</option>
              {/each}
            </select>
          {:else}
            <select value={$settings.aiProvider || 'anthropic'} onchange={(e) => setAiProvider(e.target.value)}>
              {#if aiProviders.length === 0}
                <option value="">No providers available</option>
              {/if}
              {#each aiProviders as p}
                <option value={p.id}>{p.name}</option>
              {/each}
            </select>
          {/if}
        </div>
      </div>

      {#if aiMode !== 'cloud'}
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">API Key</span>
            <span class="setting-desc">
              {#if aiConfig.hasKey}
                ✅ Key configured.
                <button class="btn-ghost text-sm" style="color: var(--error)" onclick={removeKey}>Remove</button>
              {:else}
                Get yours at <button type="button" class="provider-doc-link" onclick={() => window.api.setup.openDownloadPage($settings.aiProvider)}>
                  {aiProviders.find(p => p.id === $settings.aiProvider)?.name || 'provider'} docs
                </button>
              {/if}
            </span>
          </div>
          {#if !aiConfig.hasKey}
            <div class="setting-control">
              <div class="key-input-group">
                <input
                  type="password"
                  bind:value={apiKeyInput}
                  placeholder={aiProviders.find(p => p.id === $settings.aiProvider)?.keyPlaceholder || 'Enter API key'}
                  class="key-input"
                  onkeydown={(e) => e.key === 'Enter' && saveApiKey()}
                />
                <button class="btn-primary btn-sm" onclick={saveApiKey} disabled={savingKey || !apiKeyInput.trim()}>
                  {savingKey ? 'Verifying…' : 'Save'}
                </button>
              </div>
              {#if keyError}
                <p class="key-error">{keyError}</p>
              {/if}
              {#if keySuccess}
                <p class="key-success">{keySuccess}</p>
              {/if}
            </div>
          {/if}
        </div>
      {:else}
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">Cloud Account</span>
            <span class="setting-desc">
              {#if $cloudReady}
                Using your signed-in CourseCode Cloud account for AI.
              {:else}
                Sign in to CourseCode Cloud to use cloud AI models.
              {/if}
            </span>
          </div>
          <div class="setting-control">
            {#if !$cloudReady}
              <button class="btn-primary btn-sm" onclick={startLogin} disabled={signingIn}>Sign In</button>
            {:else}
              <span class="text-secondary text-sm">Connected</span>
            {/if}
          </div>
        </div>
      {/if}

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">Model</span>
          <span class="setting-desc">Select the AI model to use.</span>
          {#if aiMode === 'cloud' && !$cloudReady}
            <span class="setting-desc">Sign in to CourseCode Cloud to load cloud models.</span>
          {/if}
          {#if aiMode !== 'cloud' && !selectedByokProvider?.hasKey}
            <span class="setting-desc">Add an API key to load models.</span>
          {/if}
          {#if aiMode !== 'cloud' && selectedByokProvider?.hasKey && selectedByokProvider?.modelFetchFailed}
            <span class="setting-desc" style="color: var(--error)">Unable to load provider models. Click Refresh after fixing key/network.</span>
          {/if}
          {#if aiMode === 'cloud' && $cloudReady && effectiveCloudModels.length === 0}
            <span class="setting-desc" style="color: var(--error)">No cloud models available yet. Refresh after first successful cloud connection.</span>
          {/if}
          {#if aiMode === 'cloud' && $cloudReady && effectiveCloudModels.length > 0 && filteredCloudModels.length === 0}
            <span class="setting-desc" style="color: var(--error)">No cloud models available for this provider filter.</span>
          {/if}
          {#if aiMode === 'cloud' && $cloudReady && cloudModelLoadError && cachedCloudModels.length > 0}
            <span class="setting-desc" style="color: var(--warning)">Cloud refresh failed, showing last known model list.</span>
          {/if}
        </div>
        <div class="setting-control">
          <div class="model-row">
            {#if aiMode === 'cloud'}
              <select
                value={$settings.cloudAiModel || ''}
                onchange={(e) => updateSetting('cloudAiModel', e.target.value)}
                disabled={!$cloudReady || filteredCloudModels.length === 0}
              >
                {#if filteredCloudModels.length === 0}
                  <option value="">No cloud models available</option>
                {/if}
                {#each filteredCloudModels as m}
                  <option value={m.id}>{m.label || m.name || m.id}</option>
                {/each}
              </select>
            {:else}
              <select
                value={$settings.aiModel || ''}
                onchange={(e) => setAiModel(e.target.value)}
                disabled={!selectedByokProvider?.hasKey || !(selectedByokProvider?.models?.length)}
              >
                {#if !selectedByokProvider?.hasKey}
                  <option value="">Add API key to load models</option>
                {:else if !(selectedByokProvider?.models?.length)}
                  <option value="">No BYOK models available</option>
                {/if}
                {#each (selectedByokProvider?.models || []) as m}
                  <option value={m.id}>{m.label}</option>
                {/each}
              </select>
            {/if}
            <button class="btn-secondary btn-sm" onclick={refreshAvailableModels} disabled={refreshingModels}>
              {refreshingModels ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">Custom Instructions</span>
          <span class="setting-desc">Add extra instructions for the AI.</span>
        </div>
        <div class="setting-control">
          <textarea
            class="custom-instructions"
            value={$settings.aiCustomInstructions || ''}
            onblur={saveCustomInstructions}
            placeholder="e.g., Always use formal language. Focus on safety compliance topics."
            rows="3"
          ></textarea>
        </div>
      </div>
    </section>

    <!-- Cloud Account -->
    <section class="settings-section">
      <h3 class="section-title">Cloud Account</h3>
      {#if $user}
        <div class="cloud-info">
          <div class="cloud-user">
            <div class="avatar-lg">{$user.email?.[0]?.toUpperCase()}</div>
            <div>
              <p class="cloud-email">{$user.email}</p>
              {#if $user.org}
                <p class="text-secondary text-sm">{$user.org}</p>
              {/if}
            </div>
          </div>
          <button class="btn-secondary" onclick={logout}>Sign Out</button>
        </div>
        {#if $credits != null}
          <div class="credits-row">
            <div class="credits-display">
              <span class="credits-value">{Math.round($credits.remaining)}</span>
              <span class="credits-label">credits remaining</span>
            </div>
            <a
              href="https://coursecodecloud.com/account/credits"
              target="_blank"
              class="btn-ghost text-sm"
            >Top up →</a>
          </div>
        {/if}
      {:else}
        <button class="btn-primary" onclick={startLogin} disabled={signingIn}>Sign In to CourseCode Cloud</button>

        {#if deviceStage === 'requesting'}
          <p class="text-secondary text-sm mt-sm">Connecting…</p>
        {:else if deviceStage === 'device'}
          <div class="device-auth-card mt-md">
            <p class="device-step"><span class="device-step-num">1</span> Open this page in your browser:</p>
            <div class="device-url-row">
              <code class="device-url">{deviceVerificationUri}</code>
              <button class="btn-primary btn-sm" onclick={() => window.api.shell.openExternal(deviceVerificationUri)}>Open Page</button>
            </div>
            <p class="device-step mt-md"><span class="device-step-num">2</span> Enter this code when prompted:</p>
            <div class="device-code-row">
              <span class="device-code">{deviceUserCode}</span>
              <button class="btn-secondary btn-sm" onclick={() => navigator.clipboard.writeText(deviceUserCode)}>Copy</button>
            </div>
            <p class="text-secondary text-sm mt-md">⏳ Waiting for you to approve in the browser…</p>
          </div>
        {:else if deviceStage === 'approved'}
          <p class="text-secondary text-sm mt-sm">Approved! Signing in…</p>
        {:else if deviceStage === 'error'}
          <p class="login-error mt-sm">{deviceErrorMessage || 'Sign in failed. Please try again.'}</p>
        {:else if $loginError}
          <p class="login-error mt-sm">
            {#if $loginError.code === 'FIREWALL_BLOCK'}
              🔒 Your network is blocking CourseCode Cloud. Ask IT to allow access, or try from a different network.
            {:else}
              {$loginError.message || 'Sign in failed. Please try again.'}
            {/if}
          </p>
        {/if}
      {/if}
    </section>

    <!-- About -->
    <section class="settings-section">
      <h3 class="section-title">About</h3>
      <div class="about-info">
        <p>CourseCode Desktop v{appVersion || 'unknown'}</p>
        <div class="setting-row update-row">
          <div class="setting-info">
            <span class="setting-label">Updates</span>
            <span class="setting-desc">{updateStatus?.message || 'Automatic updates are enabled for installed builds.'}</span>
          </div>
          <div class="setting-control">
            {#if updateStatus?.state === 'downloaded'}
              <button class="btn-primary btn-sm" onclick={installUpdate}>Install and Restart</button>
            {:else}
              <button class="btn-secondary btn-sm" onclick={checkForUpdates} disabled={checkingUpdates || updateStatus?.state === 'downloading'}>
                {updateButtonLabel()}
              </button>
            {/if}
          </div>
        </div>
        <p class="text-secondary text-sm mt-sm">MIT License · Open Source</p>
        <div class="about-links mt-md">
          <a href="https://coursecodedesktop.com/docs" target="_blank">Documentation</a>
          <span class="text-tertiary">·</span>
          <a href="https://github.com/course-code-framework/coursecode-desktop/issues" target="_blank">Report Issue</a>
        </div>
      </div>
    </section>
  </div>
</div>

<style>
  .settings-view {
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  .settings-header {
    display: flex;
    align-items: center;
    gap: var(--sp-md);
    padding: var(--sp-md) var(--sp-xl);
    border-bottom: 1px solid var(--border);
    background: var(--bg-elevated);
    flex-shrink: 0;
  }

  .settings-content {
    flex: 1;
    overflow-y: auto;
    padding: var(--sp-xl);
    max-width: 700px;
    margin: 0 auto;
    width: 100%;
  }

  .settings-section {
    margin-bottom: var(--sp-xl);
    padding-bottom: var(--sp-xl);
    border-bottom: 1px solid var(--border);
  }

  .settings-section:last-child {
    border-bottom: none;
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .section-title {
    font-size: var(--text-lg);
    margin-bottom: var(--sp-lg);
  }

  .setting-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--sp-xl);
    padding: var(--sp-md) 0;
  }

  .update-row {
    padding: var(--sp-sm) 0 0;
  }

  .setting-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .model-row {
    display: flex;
    gap: var(--sp-sm);
    width: 100%;
    align-items: center;
  }

  .model-row select {
    flex: 1;
    min-width: 0;
  }

  .setting-label {
    font-weight: 500;
  }

  .setting-desc {
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }

  .setting-control {
    flex-shrink: 0;
    min-width: 200px;
  }

  .toggle-check {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-sm);
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }

  .path-input {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    background: var(--bg-secondary);
    cursor: default;
  }

  .path-row {
    display: flex;
    gap: var(--sp-sm);
    align-items: center;
  }

  .path-row .path-input {
    flex: 1;
    min-width: 0;
  }

  select {
    font-family: inherit;
    font-size: var(--text-base);
    padding: var(--sp-sm) var(--sp-md);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-input);
    color: var(--text-primary);
    width: 100%;
  }

  .theme-buttons {
    display: flex;
    gap: var(--sp-sm);
  }

  .theme-btn {
    padding: var(--sp-sm) var(--sp-md);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: var(--text-sm);
    cursor: pointer;
    transition: all var(--duration-fast) var(--ease);
  }

  .theme-btn.active {
    border-color: var(--accent);
    background: var(--accent-subtle);
    color: var(--accent);
  }

  .tools-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--sp-md);
  }

  .cloud-info {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .cloud-user {
    display: flex;
    align-items: center;
    gap: var(--sp-md);
  }

  .avatar-lg {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: var(--accent);
    color: var(--text-on-accent);
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    font-size: var(--text-lg);
  }

  .cloud-email {
    font-weight: 500;
  }

  .about-info {
    color: var(--text-secondary);
  }

  .about-links {
    display: flex;
    gap: var(--sp-sm);
    font-size: var(--text-sm);
  }

  .key-input-group {
    display: flex;
    gap: var(--sp-sm);
  }

  .key-input {
    flex: 1;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }

  .key-error {
    color: var(--error);
    font-size: var(--text-sm);
    margin: var(--sp-xs) 0 0;
  }

  .key-success {
    color: var(--success);
    font-size: var(--text-sm);
    margin: var(--sp-xs) 0 0;
  }

  .login-error {
    font-size: var(--text-sm);
    color: var(--text-secondary);
    background: var(--warning-subtle);
    border: 1px solid color-mix(in srgb, var(--warning) 25%, transparent);
    border-radius: var(--radius-sm);
    padding: var(--sp-sm) var(--sp-md);
    line-height: 1.5;
  }

  .custom-instructions {
    width: 100%;
    font-family: inherit;
    font-size: var(--text-sm);
    padding: var(--sp-sm) var(--sp-md);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-input);
    color: var(--text-primary);
    resize: vertical;
    line-height: 1.5;
  }

  .custom-instructions::placeholder {
    color: var(--text-tertiary);
  }

  .btn-sm {
    padding: var(--sp-xs) var(--sp-md);
    font-size: var(--text-sm);
  }

  .mode-toggle {
    display: flex;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }

  .mode-btn {
    flex: 1;
    padding: var(--sp-xs) var(--sp-md);
    background: var(--bg-primary);
    border: none;
    color: var(--text-secondary);
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
    transition: all var(--duration-fast) var(--ease);
  }

  .mode-btn + .mode-btn {
    border-left: 1px solid var(--border);
  }

  .mode-btn.active {
    background: var(--accent-subtle);
    color: var(--accent);
  }

  .mode-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .credits-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: var(--sp-md);
    padding: var(--sp-md);
    background: var(--bg-secondary);
    border-radius: var(--radius-md);
  }

  .credits-display {
    display: flex;
    align-items: baseline;
    gap: var(--sp-sm);
  }

  .credits-value {
    font-size: var(--text-xl);
    font-weight: 700;
    color: var(--accent);
  }

  .credits-label {
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }

  .provider-doc-link {
    background: none;
    border: none;
    padding: 0;
    color: var(--accent);
    text-decoration: underline;
    font-size: inherit;
    font-weight: 500;
    cursor: pointer;
  }

  /* Device code auth card */
  :global(.device-auth-card) {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: var(--sp-lg);
  }
  :global(.device-step) {
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
    margin: 0;
  }
  :global(.device-step-num) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    background: var(--accent);
    color: #fff;
    border-radius: 50%;
    font-size: 11px;
    font-weight: 700;
    flex-shrink: 0;
  }
  :global(.device-url-row) {
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
    margin-top: var(--sp-sm);
    flex-wrap: wrap;
  }
  :global(.device-url) {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    background: var(--bg-primary);
    padding: var(--sp-xs) var(--sp-sm);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    color: var(--text-secondary);
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  :global(.device-code-row) {
    display: flex;
    align-items: center;
    gap: var(--sp-md);
    margin-top: var(--sp-sm);
  }
  :global(.device-code) {
    font-family: var(--font-mono);
    font-size: 2rem;
    font-weight: 700;
    letter-spacing: 0.18em;
    color: var(--text-primary);
    background: var(--bg-primary);
    border: 2px solid var(--accent);
    border-radius: var(--radius-md);
    padding: var(--sp-sm) var(--sp-lg);
  }
</style>
