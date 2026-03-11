<script>
  import { onMount, onDestroy } from 'svelte';
  import { loadSettings, settings } from './stores/settings.js';
  import { loadCloudUser, cloudReady } from './stores/auth.js';
  import { aiMode } from './stores/chat.js';
  import { tabs, activeTab, activeTabId, openCourseTab, closeTab } from './stores/tabs.js';
  import TabBar from './components/TabBar.svelte';
  import Dashboard from './views/Dashboard.svelte';
  import CreateWizard from './views/CreateWizard.svelte';
  import ProjectDetail from './views/ProjectDetail.svelte';
  import Settings from './views/Settings.svelte';
  import SetupAssistant from './views/SetupAssistant.svelte';
  import ToastContainer from './components/ToastContainer.svelte';

  let overlay = $state(null); // 'create' | 'settings' | 'setup' | null
  let ready = $state(false);
  let updateToastVisible = $state(false);
  let updateToastMessage = $state('An update is ready to install.');
  let updateToastDismissed = $state(false);
  let updateToastBusy = $state(false);
  let unsubUpdateStatus = null;
  let unsubNavigate = null;
  const isMac = navigator.platform.includes('Mac');
  const currentView = $derived(() => {
    if (!ready) return 'loading';
    if (overlay === 'setup') return 'setup';
    if (overlay === 'create') return 'create';
    if (overlay === 'settings') return 'settings';
    return $activeTab?.type === 'home' ? 'dashboard' : 'project';
  });

  function showOverlay(name) {
    overlay = name;
  }

  function closeOverlay() {
    overlay = null;
  }

  async function handleOpenProject(path, title) {
    const opened = openCourseTab(path, title || path.split('/').pop());
    if (!opened) {
      // Tab limit reached — could show a toast, for now just focus home
      activeTabId.set('home');
      return;
    }
    // Auto-start preview server when tab opens
    try {
      const status = await window.api.preview.status(path);
      if (status !== 'running') {
        await window.api.preview.start(path, { openBrowser: false });
      }
    } catch { /* ignore — ProjectDetail will handle retry */ }
  }

  /** Close a course tab, stopping its server. Called from Dashboard too. */
  async function handleCloseProject(path) {
    closeTab(path);
    try {
      const status = await window.api.preview.status(path);
      if (status === 'running' && !$settings.keepPreviewRunningWithoutTab) {
        await window.api.preview.stop(path);
      }
    } catch { /* ignore */ }
  }


  onMount(async () => {
    await loadSettings();
    const cloudUser = await loadCloudUser();

    const s = $settings;
    // First-time AI mode default: prefer Cloud when user is authenticated.
    // After first use/selection, restore the persisted mode.
    if (s.aiModeInitialized) {
      aiMode.set(s.defaultAiMode || 'byok');
    } else {
      aiMode.set(cloudUser ? 'cloud' : 'byok');
    }
    if (!s.setupCompleted) {
      overlay = 'setup';
    }

    unsubUpdateStatus = window.api.app.onUpdateStatus((status) => {
      if (status?.state === 'downloaded') {
        updateToastMessage = status.message || 'Update downloaded. Restart to install.';
        if (!updateToastDismissed) updateToastVisible = true;
      }
    });

    unsubNavigate = window.api.app.onNavigate?.((target) => {
      if (target === 'settings') showOverlay('settings');
      else if (target === 'create') showOverlay('create');
    });

    ready = true;
  });

  onDestroy(() => {
    unsubUpdateStatus?.();
    unsubNavigate?.();
  });

  function dismissUpdateToast() {
    updateToastVisible = false;
    updateToastDismissed = true;
  }

  async function installUpdateNow() {
    updateToastBusy = true;
    try {
      await window.api.app.installUpdate();
    } finally {
      updateToastBusy = false;
    }
  }

  // Apply theme
  $effect(() => {
    const theme = $settings.theme || 'system';
    if (theme === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
  });

  // First-time AI mode default should track cloud auth state until mode is initialized.
  $effect(() => {
    if (!ready) return;
    if ($settings.aiModeInitialized) return;
    aiMode.set($cloudReady ? 'cloud' : 'byok');
  });
</script>

<!-- macOS: titlebar with tabs inline -->
{#if isMac}
  <div class="titlebar-drag">
    <div class="titlebar-brand">
      <svg width="20" height="20" viewBox="0 18 100 64" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="25,22 5,50 25,78" />
        <polyline points="75,22 95,50 75,78" />
        <path d="M50,28 C40,28 33,36 33,45 C33,52 38,56 42,60 L42,65 L58,65 L58,60 C62,56 67,52 67,45 C67,36 60,28 50,28" stroke-width="4" />
        <line x1="44" y1="70" x2="56" y2="70" stroke-width="4" />
        <line x1="46" y1="75" x2="54" y2="75" stroke-width="4" />
      </svg>
      <span class="titlebar-brand-text">CourseCode</span>
    </div>
    <div class="titlebar-tabs">
      {#if !overlay && ready}
        <TabBar
          onTabClose={handleCloseProject}
          onOpenSettings={() => showOverlay('settings')}
        />
      {/if}
    </div>
    <div class="titlebar-grab" aria-hidden="true"></div>
  </div>
{/if}

<div class="app-container" class:has-titlebar={isMac} data-testid="app-container" data-view={currentView()}>
  {#if !ready}
    <div class="loading-screen" data-testid="loading-screen">
      <div class="loading-spinner"></div>
    </div>
  {:else if overlay === 'setup'}
    <SetupAssistant onComplete={() => closeOverlay()} />
  {:else if overlay === 'create'}
    <CreateWizard
      onClose={closeOverlay}
      onOpenSetup={() => showOverlay('setup')}
      onCreated={(project) => {
        closeOverlay();
        handleOpenProject(project.path, project.title || project.name);
      }}
    />
  {:else if overlay === 'settings'}
    <Settings onBack={closeOverlay} onRunSetup={() => showOverlay('setup')} />
  {:else}
    <!-- Tab bar (non-Mac only; Mac tabs are in the titlebar) -->
    {#if !isMac}
      <TabBar
        onTabClose={handleCloseProject}
        onOpenSettings={() => showOverlay('settings')}
      />
    {/if}

    <div class="tab-content">
      {#each $tabs as tab (tab.id)}
        <div class="tab-panel" class:visible={$activeTabId === tab.id}>
          {#if tab.type === 'home'}
            <Dashboard
              onCreateNew={() => showOverlay('create')}
              onOpenProject={handleOpenProject}
              onCloseProject={handleCloseProject}
              onOpenSettings={() => showOverlay('settings')}
            />
          {:else if tab.type === 'course'}
            <ProjectDetail projectPath={tab.path} />
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

{#if updateToastVisible}
  <div class="update-toast" role="status" aria-live="polite">
    <div class="update-toast-text">{updateToastMessage}</div>
    <div class="update-toast-actions">
      <button class="btn-secondary btn-sm" onclick={dismissUpdateToast} disabled={updateToastBusy}>Later</button>
      <button class="btn-primary btn-sm" onclick={installUpdateNow} disabled={updateToastBusy}>
        {updateToastBusy ? 'Installing...' : 'Install and Restart'}
      </button>
    </div>
  </div>
{/if}

<ToastContainer />

<style>
  .app-container {
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  .app-container.has-titlebar {
    padding-top: var(--titlebar-height);
  }

  .titlebar-brand {
    margin-left: 84px; /* clear macOS traffic lights */
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
    padding: 0 var(--sp-md);
    flex-shrink: 0;
    height: 100%;
    color: var(--text-primary);
    -webkit-app-region: no-drag;
  }

  .titlebar-brand-text {
    color: var(--text-primary);
    font-size: var(--text-sm);
    font-weight: 600;
    letter-spacing: 0.02em;
    white-space: nowrap;
    opacity: 0.85;
  }

  .titlebar-tabs {
    height: 100%;
    display: flex;
    align-items: stretch;
    flex: 1;
    min-width: 0;
    -webkit-app-region: no-drag;
  }

  .titlebar-grab {
    width: 72px;
    flex-shrink: 0;
  }

  .loading-screen {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .loading-spinner {
    width: 32px;
    height: 32px;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .tab-content {
    flex: 1;
    min-height: 0;
    position: relative;
  }

  .tab-panel {
    position: absolute;
    inset: 0;
    display: none;
  }

  .tab-panel.visible {
    display: flex;
    flex-direction: column;
    animation: panelFadeIn 220ms var(--ease);
  }

  @keyframes panelFadeIn {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  @media (prefers-reduced-motion: reduce) {
    .tab-panel.visible {
      animation: none;
    }
  }

  .update-toast {
    position: fixed;
    right: var(--sp-lg);
    bottom: var(--sp-lg);
    width: min(420px, calc(100vw - (var(--sp-lg) * 2)));
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    box-shadow: var(--shadow-lg);
    border-radius: var(--radius-md);
    padding: var(--sp-md);
    display: flex;
    flex-direction: column;
    gap: var(--sp-sm);
    z-index: 300;
    animation: toastIn 180ms var(--ease);
  }

  .update-toast-text {
    color: var(--text-primary);
    font-size: var(--text-sm);
  }

  .update-toast-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--sp-sm);
  }

  @keyframes toastIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
