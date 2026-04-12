<script>
  import { onMount, onDestroy } from 'svelte';
  import { settings, updateSetting } from '../stores/settings.js';

  let { onComplete } = $props();

  let step = $state(0);
  let setupStatus = $state(null);
  let checkingStatus = $state(false);
  let cliInstalling = $state(false);
  let cliPhase = $state('idle'); // idle | installing | verifying | complete
  let cliProgressLines = $state([]);
  let cliError = $state(null);
  let lastSavedStep = $state(null);
  let justDownloadedTool = $state(null);
  let loginStage = $state(null); // null | 'requesting' | 'device' | 'approved' | 'complete' | 'error'
  let loginMessage = $state('');
  let loginUser = $state(null);
  let loginUserCode = $state(null);
  let loginVerificationUri = $state(null);
  let workflowPreset = $state('ai');
  let unsubInstall = null;
  let unsubLogin = null;
  let focusHandler = null;
  let visibilityHandler = null;

  const steps = [
    { id: 'welcome', title: 'Welcome', icon: '👋' },
    { id: 'cli', title: 'CourseCode Tools', icon: '🔧' },
    { id: 'vcs', title: 'Auto-Deploy', icon: '🚀' },
    { id: 'cloud', title: 'Cloud Account', icon: '☁️' },
    { id: 'done', title: 'All Set', icon: '✅' }
  ];

  onMount(async () => {
    const savedStep = Number($settings.lastSetupStep);
    if (!$settings.setupCompleted && Number.isInteger(savedStep)) {
      step = Math.min(Math.max(savedStep, 0), steps.length - 1);
    }

    await refreshSetupStatus();

    focusHandler = () => {
      refreshSetupStatus();
    };
    visibilityHandler = () => {
      if (document.visibilityState === 'visible') refreshSetupStatus();
    };
    window.addEventListener('focus', focusHandler);
    document.addEventListener('visibilitychange', visibilityHandler);
  });

  onDestroy(() => {
    unsubInstall?.();
    unsubLogin?.();
    if (focusHandler) window.removeEventListener('focus', focusHandler);
    if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler);
  });

  $effect(() => {
    if ($settings.setupCompleted) return;
    if (step === lastSavedStep) return;
    lastSavedStep = step;
    void updateSetting('lastSetupStep', step);
  });

  function appendInstallLog(text, type = 'stdout') {
    const cleaned = (text || '').trim();
    if (!cleaned) return;
    const prefix = type === 'stderr' ? '[err] ' : '';
    cliProgressLines = [...cliProgressLines, `${prefix}${cleaned}`].slice(-120);
  }

  async function refreshSetupStatus() {
    checkingStatus = true;
    try {
      const next = await window.api.setup.getStatus();
      setupStatus = next;
      if (justDownloadedTool && isToolInstalled(justDownloadedTool, next)) {
        justDownloadedTool = null;
      }
    } catch {
      // Ignore background refresh failures; explicit actions surface their own errors.
    } finally {
      checkingStatus = false;
    }
  }

  function isToolInstalled(toolId, status) {
    if (!status) return false;
    if (toolId === 'git') return !!status.git?.installed || status.git?.state === 'installed-configured';
    return status[toolId]?.state !== 'not-installed';
  }

  function cliPhaseLabel() {
    if (cliPhase === 'verifying') return 'Verifying installation...';
    if (cliPhase === 'complete') return 'Install complete';
    return 'Installing CourseCode tools...';
  }

  async function installCLI() {
    cliInstalling = true;
    cliPhase = 'installing';
    cliProgressLines = [];
    cliError = null;

    unsubInstall?.();
    unsubInstall = window.api.setup.onInstallProgress((data) => {
      if (data?.type === 'phase') {
        cliPhase = data.phase || 'installing';
        appendInstallLog(data.text, 'stdout');
        return;
      }
      if (data?.type === 'stderr') {
        appendInstallLog(data.text, 'stderr');
        return;
      }
      appendInstallLog(data?.text, 'stdout');
    });

    try {
      await window.api.setup.installCLI();
      cliPhase = 'complete';
      await refreshSetupStatus();
    } catch (err) {
      cliPhase = 'idle';
      cliError = err.message;
    } finally {
      cliInstalling = false;
      unsubInstall?.();
      unsubInstall = null;
    }
  }

  async function startLogin() {
    loginStage = 'waiting';
    loginMessage = 'Opening browser…';

    unsubLogin = window.api.cloud.onLoginProgress((data) => {
      if (data.stage === 'device') {
        loginStage = 'device';
        loginUserCode = data.userCode;
        loginVerificationUri = data.verificationUri;
      } else if (data.stage === 'approved') {
        loginStage = 'approved';
        loginMessage = data.message || 'Approved! Signing in…';
      } else if (data.stage === 'complete') {
        loginStage = 'complete';
        loginMessage = data.message || 'Signed in!';
        if (data.user) loginUser = data.user;
      } else if (data.stage === 'error') {
        loginStage = 'error';
        loginMessage = data.message || 'Sign in failed. Try again.';
      } else {
        loginStage = 'requesting';
        loginMessage = data.message || 'Connecting…';
      }
    });

    try {
      const result = await window.api.cloud.login();
      if (result?.user) loginUser = result.user;
      loginStage = 'complete';
      loginMessage = 'Signed in!';
      setupStatus = await window.api.setup.getStatus();
    } catch (err) {
      loginStage = 'error';
      loginMessage = err?.code === 'FIREWALL_BLOCK'
        ? "Your network's firewall is blocking CourseCode Cloud. Ask your IT team to allow access, or try from a different network."
        : 'Sign in failed. Try again.';
    } finally {
      unsubLogin?.();
    }
  }

  function copyLoginCode() {
    if (loginUserCode) window.api.clipboard.writeText(loginUserCode);
  }

  function openActivationPage() {
    if (loginVerificationUri) window.api.shell.openExternal(loginVerificationUri);
  }

  function openDownload(tool) {
    justDownloadedTool = tool;
    window.api.setup.openDownloadPage(tool);
  }

  async function chooseWorkflow(preset) {
    workflowPreset = preset;
    if (preset === 'gui') {
      await updateSetting('aiChatEnabled', false);
      await updateSetting('keepPreviewRunningWithoutTab', true);
      return;
    }

    await updateSetting('aiChatEnabled', true);
    await updateSetting('keepPreviewRunningWithoutTab', false);
  }

  async function finish() {
    await updateSetting('setupCompleted', true);
    await updateSetting('lastSetupStep', 0);
    onComplete();
  }

  function next() {
    if (step < steps.length - 1) step++;
    else finish();
  }

  function prev() {
    if (step > 0) step--;
  }
</script>

<div class="setup" data-testid="setup-assistant">
  <div class="setup-sidebar">
    <div class="sidebar-header">
      <h2 class="sidebar-title">Setup</h2>
    </div>
    <nav class="step-nav">
      {#each steps as s, i}
        <button
          class="step-item"
          class:active={step === i}
          class:complete={step > i}
          onclick={() => { if (i <= step) step = i; }}
          data-testid={`setup-step-nav-${s.id}`}
        >
          <span class="step-icon">{s.icon}</span>
          <span class="step-label">{s.title}</span>
          {#if step > i}
            <svg class="step-check" width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M3 8l4 4 6-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          {/if}
        </button>
      {/each}
    </nav>
  </div>

  <div class="setup-content">
    <div class="step-body">
      {#if step === 0}
        <!-- Welcome -->
        <div class="hero-step" data-testid="setup-welcome">
          <svg class="hero-logo" width="64" height="64" viewBox="0 18 100 64" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="25,22 5,50 25,78" />
            <polyline points="75,22 95,50 75,78" />
            <path d="M50,28 C40,28 33,36 33,45 C33,52 38,56 42,60 L42,65 L58,65 L58,60 C62,56 67,52 67,45 C67,36 60,28 50,28" stroke-width="4" />
            <line x1="44" y1="70" x2="56" y2="70" stroke-width="4" />
            <line x1="46" y1="75" x2="54" y2="75" stroke-width="4" />
          </svg>
          <h1>Welcome to CourseCode</h1>
          <p class="hero-desc">Let's get your environment set up. This only takes a minute, and you can revisit these settings anytime.</p>
          <p class="hero-subdesc text-secondary">We'll check for a few tools that make course creation easier. Nothing is required — you can skip anything you'd like.</p>

          <div class="preset-grid mt-lg">
            <button class="preset-card" class:active={workflowPreset === 'ai'} onclick={() => chooseWorkflow('ai')} data-testid="preset-ai">
              <p class="preset-title">✨ AI-Assisted</p>
              <p class="preset-desc">Have the AI help you build and improve courses. The chat panel is open by default.</p>
            </button>
            <button class="preset-card" class:active={workflowPreset === 'gui'} onclick={() => chooseWorkflow('gui')} data-testid="preset-gui">
              <p class="preset-title">🖥️ Manual</p>
              <p class="preset-desc">Build courses yourself. No AI panel — just the editor and live preview.</p>
            </button>
          </div>
        </div>

      {:else if step === 1}
        <!-- CLI Install -->
        <h2>CourseCode Tools</h2>
        <p class="step-desc mt-sm">This installs everything needed to build, preview, and export your courses. It only takes a minute and happens automatically.</p>

        {#if setupStatus?.cli?.state === 'installed-configured'}
          <div class="status-card success mt-lg">
            <span class="status-emoji">✅</span>
            <div>
              <p class="status-title">CourseCode tools are ready</p>
              {#if setupStatus.cli.version}
                <p class="text-secondary text-sm">Version: {setupStatus.cli.version}</p>
              {/if}
            </div>
          </div>
        {:else}
          <div class="status-card neutral mt-lg">
            <span class="status-emoji">📦</span>
            <div>
              <p class="status-title">CourseCode tools need to be installed</p>
              <p class="text-secondary text-sm">This enables building, previewing, and AI-assisted course creation.</p>
            </div>
          </div>
          {#if cliError}
            <p class="error-text mt-sm">{cliError}</p>
          {/if}
          {#if cliInstalling}
            <div class="status-card neutral mt-sm">
              <span class="status-emoji spinner">⏳</span>
              <div>
                <p class="status-title">{cliPhaseLabel()}</p>
                <p class="text-secondary text-sm">Please keep this window open until installation is complete.</p>
              </div>
            </div>
          {/if}
          {#if cliProgressLines.length > 0}
            <pre class="install-log mt-sm" aria-live="polite">{cliProgressLines.join('\n')}</pre>
          {/if}
          <button class="btn-primary btn-lg mt-lg" onclick={installCLI} disabled={cliInstalling} data-testid="install-cli-btn">
            {cliInstalling ? cliPhaseLabel() : 'Install CourseCode Tools'}
          </button>
        {/if}

      {:else if step === 2}
        <!-- Auto-Deploy -->
        <h2>Auto-Deploy <span class="optional-badge">Optional</span></h2>
        <p class="step-desc mt-sm">Want to publish your course to the web with one click? This sets up the connection. You can skip it now and set it up later.</p>

        {#if setupStatus?.git?.installed}
          <div class="status-card success mt-lg">
            <span class="status-emoji">✅</span>
            <div>
              <p class="status-title">You're ready to auto-deploy</p>
              <p class="text-secondary text-sm">Publish courses to the web straight from the app.</p>
            </div>
          </div>
        {:else}
          <div class="status-card neutral mt-lg">
            <span class="status-emoji">🔄</span>
            <div>
              <p class="status-title">Not set up yet</p>
              <p class="text-secondary text-sm">GitHub Desktop is the easiest way — a simple app that handles this for you behind the scenes. Totally free.</p>
            </div>
          </div>
          <div class="step-actions mt-lg">
            <button class="btn-primary btn-lg" onclick={() => openDownload('githubDesktop')}>
              Download GitHub Desktop (Free)
            </button>
            <button class="btn-secondary" onclick={refreshSetupStatus} disabled={checkingStatus}>
              {checkingStatus && justDownloadedTool === 'githubDesktop' ? 'Checking...' : 'I installed it'}
            </button>
          </div>
          <p class="text-secondary text-sm mt-sm">Download GitHub Desktop, open it, sign in, and click "I installed it" to continue.</p>
        {/if}

      {:else if step === 3}
        <!-- Cloud Account -->
        <h2>Cloud Account</h2>
        <p class="step-desc mt-sm">Optional: sign in to deploy courses to the web with one click. You can skip this and sign in later from Settings.</p>

        {#if setupStatus?.cloud?.state === 'installed-configured' || loginStage === 'complete'}
          <div class="status-card success mt-lg">
            <span class="status-emoji">✅</span>
            <div>
              <p class="status-title">{loginUser?.full_name ? `Signed in as ${loginUser.full_name}` : 'You\'re signed in'}</p>
              {#if loginUser?.email}
                <p class="text-secondary text-sm">{loginUser.email}</p>
              {/if}
            </div>
          </div>

        {:else if loginStage === 'requesting'}
          <div class="status-card neutral mt-lg">
            <span class="status-emoji spinner">⏳</span>
            <div>
              <p class="status-title">Connecting…</p>
            </div>
          </div>

        {:else if loginStage === 'device'}
          <div class="device-auth-card mt-lg">
            <p class="device-step"><span class="device-step-num">1</span> Open this page in your browser:</p>
            <div class="device-url-row">
              <code class="device-url">{loginVerificationUri}</code>
              <button class="btn-primary btn-sm" onclick={openActivationPage}>Open Page</button>
            </div>
            <p class="device-step mt-md"><span class="device-step-num">2</span> Enter this code when prompted:</p>
            <div class="device-code-row">
              <span class="device-code">{loginUserCode}</span>
              <button class="btn-secondary btn-sm" onclick={copyLoginCode}>Copy</button>
            </div>
            <p class="text-secondary text-sm mt-md">⏳ Waiting for you to approve in the browser…</p>
          </div>

        {:else if loginStage === 'approved'}
          <div class="status-card neutral mt-lg">
            <span class="status-emoji spinner">⏳</span>
            <div>
              <p class="status-title">{loginMessage}</p>
            </div>
          </div>

        {:else if loginStage === 'error'}
          <div class="status-card warning mt-lg">
            <span class="status-emoji">⚠️</span>
            <div>
              <p class="status-title">{loginMessage}</p>
            </div>
          </div>
          <button class="btn-primary btn-lg mt-lg" onclick={startLogin}>
            Try Again
          </button>

        {:else}
          <div class="status-card neutral mt-lg">
            <span class="status-emoji">☁️</span>
            <div>
              <p class="status-title">Not signed in (Optional)</p>
              <p class="text-secondary text-sm">Sign in now for one-click deploy, or skip and continue using local preview/export.</p>
            </div>
          </div>
          <button class="btn-primary btn-lg mt-lg" onclick={startLogin}>
            Sign In to CourseCode Cloud
          </button>
        {/if}

      {:else if step === 4}
        <!-- Done -->
        <div class="hero-step" data-testid="setup-done">
          <span class="hero-emoji">🎉</span>
          <h1>You're All Set!</h1>
          <p class="hero-desc">Everything is ready. You can create your first course or explore the app.</p>
          <p class="hero-subdesc text-secondary mt-sm">You can always revisit this setup from Settings → Tools & Integrations.</p>
        </div>
      {/if}
    </div>

    <div class="step-footer">
      {#if step > 0}
        <button class="btn-secondary" onclick={prev} data-testid="setup-back-btn">Back</button>
      {:else}
        <div></div>
      {/if}

      {#if step === steps.length - 1}
        <button class="btn-primary btn-lg" onclick={finish} data-testid="setup-finish-btn">Get Started</button>
      {:else}
        <div class="footer-actions">
          {#if step >= 1 && step <= 3}
            <button class="btn-ghost" onclick={next} data-testid="setup-skip-btn">Skip</button>
          {/if}
          <button class="btn-primary" onclick={next} data-testid="setup-next-btn">
            {step === 0 ? "Let's Go" : 'Continue'}
          </button>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .setup {
    height: 100%;
    display: flex;
  }

  .setup-sidebar {
    width: 240px;
    background: var(--bg-sidebar);
    color: var(--text-inverse);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    padding: var(--sp-xl) 0;
  }

  .sidebar-header {
    padding: 0 var(--sp-lg);
    margin-bottom: var(--sp-xl);
  }

  .sidebar-title {
    font-size: var(--text-xl);
    font-weight: 700;
  }

  .step-nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .step-item {
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
    padding: var(--sp-sm) var(--sp-lg);
    background: transparent;
    border: none;
    color: rgba(255, 255, 255, 0.5);
    font-size: var(--text-sm);
    cursor: pointer;
    text-align: left;
    transition: all var(--duration-fast) var(--ease);
    border-radius: 0;
  }

  .step-item:hover {
    background: var(--bg-sidebar-hover);
  }

  .step-item.active {
    background: var(--bg-sidebar-hover);
    color: white;
    font-weight: 500;
  }

  .step-item.complete {
    color: rgba(255, 255, 255, 0.7);
  }

  .step-icon {
    font-size: var(--text-base);
    width: 24px;
    text-align: center;
  }

  .step-check {
    margin-left: auto;
    color: var(--success);
  }

  .setup-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .step-body {
    flex: 1;
    padding: var(--sp-2xl);
    overflow-y: auto;
    max-width: 600px;
  }

  .step-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--sp-lg) var(--sp-2xl);
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }

  .hero-step {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--sp-md);
    padding: var(--sp-xl) 0;
  }

  .hero-emoji {
    font-size: 48px;
  }

  .hero-logo {
    color: var(--text-primary);
  }

  .hero-desc {
    font-size: var(--text-lg);
    line-height: 1.6;
    color: var(--text-primary);
    max-width: 480px;
  }

  .hero-subdesc {
    line-height: 1.6;
    max-width: 480px;
  }

  .step-desc {
    color: var(--text-secondary);
    line-height: 1.6;
    max-width: 480px;
  }

  .optional-badge {
    display: inline-block;
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--text-tertiary);
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    padding: 1px 8px;
    vertical-align: middle;
    margin-left: var(--sp-sm);
    letter-spacing: 0.02em;
  }

  .status-card {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-md);
    padding: var(--sp-lg);
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
  }

  .status-card.success {
    background: var(--success-subtle);
    border-color: color-mix(in srgb, var(--success) 20%, transparent);
  }

  .status-card.warning {
    background: var(--warning-subtle);
    border-color: color-mix(in srgb, var(--warning) 20%, transparent);
  }

  .status-card.neutral {
    background: var(--bg-secondary);
  }

  .status-emoji {
    font-size: var(--text-xl);
    flex-shrink: 0;
  }

  .status-title {
    font-weight: 600;
    margin-bottom: 2px;
  }

  .preset-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--sp-md);
    width: 100%;
    max-width: 560px;
  }

  .preset-card {
    text-align: left;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-elevated);
    padding: var(--sp-md);
    cursor: pointer;
    transition: border-color var(--duration-fast) var(--ease), background var(--duration-fast) var(--ease);
  }

  .preset-card:hover:not(.active) {
    border-color: var(--text-tertiary);
    background: var(--bg-secondary);
  }

  .preset-card.active {
    border-color: var(--accent);
    background: var(--accent-subtle);
  }

  .preset-title {
    font-weight: 600;
    margin-bottom: 4px;
  }

  .preset-desc {
    font-size: var(--text-sm);
    color: var(--text-secondary);
    line-height: 1.4;
  }


  .footer-actions {
    display: flex;
    align-items: center;
    gap: var(--sp-md);
  }

  .error-text {
    color: var(--error);
    font-size: var(--text-sm);
  }

  .spinner {
    animation: pulse 1.5s ease-in-out infinite;
  }

  .install-log {
    margin: 0;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: var(--sp-md);
    max-height: 180px;
    overflow: auto;
    font-size: 12px;
    line-height: 1.4;
    font-family: var(--font-mono);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .step-actions {
    display: flex;
    align-items: center;
    gap: var(--sp-md);
    flex-wrap: wrap;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  @media (max-width: 900px) {
    .preset-grid {
      grid-template-columns: 1fr;
    }
  }

  /* Device code auth card */
  .device-auth-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: var(--sp-lg);
  }

  .device-step {
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
    margin: 0;
  }

  .device-step-num {
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

  .device-url-row {
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
    margin-top: var(--sp-sm);
    flex-wrap: wrap;
  }

  .device-url {
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

  .device-code-row {
    display: flex;
    align-items: center;
    gap: var(--sp-md);
    margin-top: var(--sp-sm);
  }

  .device-code {
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
