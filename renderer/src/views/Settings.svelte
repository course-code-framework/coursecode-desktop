<script>
  import { settings, updateSetting } from '../stores/settings.js';
  import { user, login, logout, cloudReady } from '../stores/auth.js';
  import { credits, loadCredits } from '../stores/chat.js';
  import { showToast } from '../stores/toast.js';
  import ToolCard from '../components/ToolCard.svelte';
  import { onMount, onDestroy } from 'svelte';

  let { onBack, onRunSetup } = $props();

  let setupStatus = $state(null);
  let appVersion = $state('');
  let aiProviders = $state([]);
  let aiConfig = $state({});
  let apiKeyInput = $state('');
  let savingKey = $state(false);
  let keyError = $state('');
  let keySuccess = $state('');
  let updateStatus = $state(null);
  let checkingUpdates = $state(false);
  let unsubUpdateStatus = null;

  onMount(async () => {
    setupStatus = await window.api.setup.getStatus();
    appVersion = await window.api.app.getVersion();
    updateStatus = await window.api.app.getUpdateStatus();
    aiProviders = await window.api.ai.getProviders();
    aiConfig = await window.api.ai.getConfig();
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
  });

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
        aiProviders = await window.api.ai.getProviders();
        aiConfig = await window.api.ai.getConfig();
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
    aiProviders = await window.api.ai.getProviders();
    aiConfig = await window.api.ai.getConfig();
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
              class:active={($settings.defaultAiMode || 'byok') === 'byok'}
              onclick={() => updateSetting('defaultAiMode', 'byok')}
            >Your Key</button>
            <button
              class="mode-btn"
              class:active={$settings.defaultAiMode === 'cloud'}
              onclick={() => updateSetting('defaultAiMode', 'cloud')}
              disabled={!$cloudReady}
            >Cloud</button>
          </div>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">Provider</span>
          <span class="setting-desc">Choose your AI provider.</span>
        </div>
        <div class="setting-control">
          <select
            value={$settings.aiProvider || 'anthropic'}
            onchange={(e) => setAiProvider(e.target.value)}
          >
            {#each aiProviders as p}
              <option value={p.id}>{p.name}</option>
            {/each}
          </select>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-label">Model</span>
          <span class="setting-desc">Select the AI model to use.</span>
        </div>
        <div class="setting-control">
          <select
            value={$settings.aiModel || ''}
            onchange={(e) => setAiModel(e.target.value)}
          >
            {#each (aiProviders.find(p => p.id === $settings.aiProvider)?.models || []) as m}
              <option value={m.id}>{m.label}</option>
            {/each}
          </select>
        </div>
      </div>

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
        <button class="btn-primary" onclick={login}>Sign In to CourseCode Cloud</button>
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
</style>
