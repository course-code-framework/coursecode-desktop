<script>
  import Icon from './Icon.svelte';

  let {
    courseVersion = null,
    installedVersion = null,
    courseName = 'this course',
    projectPath = '',
    previewRunning = false,
    onclose,
    onupgraded
  } = $props();

  let upgrading = $state(false);
  let upgradeError = $state(null);
  let upgraded = $state(false);
  let newVersion = $state(null);
  let unsubProgress = null;

  const upgradeAvailable = $derived(
    courseVersion && installedVersion && compareSemver(installedVersion, courseVersion) > 0
  );

  const upToDate = $derived(
    courseVersion && installedVersion && compareSemver(installedVersion, courseVersion) === 0
  );

  function compareSemver(a, b) {
    if (!a || !b) return 0;
    const pa = a.replace(/^v/, '').split('.').map(Number);
    const pb = b.replace(/^v/, '').split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      const diff = (pa[i] || 0) - (pb[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }

  async function handleUpgrade() {
    upgrading = true;
    upgradeError = null;

    unsubProgress = window.api.projects.onUpgradeProgress((data) => {
      // Progress events stream in during upgrade — could display if needed
    });

    try {
      const result = await window.api.projects.upgrade(projectPath);
      upgraded = true;
      newVersion = result?.version || installedVersion;
      onupgraded?.(newVersion);
    } catch (err) {
      upgradeError = err?.message || 'Upgrade failed. Please try again.';
    } finally {
      upgrading = false;
      unsubProgress?.();
      unsubProgress = null;
    }
  }

  function handleKeydown(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onclose?.();
    }
  }

  function handleBackdropClick(e) {
    if (e.target === e.currentTarget) onclose?.();
  }

  function formatVersion(v) {
    if (!v) return '—';
    return v.startsWith('v') ? v : `v${v}`;
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="version-backdrop" role="dialog" aria-modal="true" aria-labelledby="version-title"
     tabindex="-1" onkeydown={handleKeydown} onclick={handleBackdropClick}>
  <div class="version-dialog">
    <div class="version-header">
      <h3 id="version-title" class="version-title">CourseCode Version</h3>
      <button class="version-close" onclick={() => onclose?.()} title="Close">
        <Icon size={18}>
          <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
        </Icon>
      </button>
    </div>

    {#if upgraded}
      <div class="version-success">
        <div class="success-icon">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="var(--success)" stroke-width="2"/>
            <path d="M8 12l3 3 5-6" stroke="var(--success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <p class="success-text">Upgraded to CourseCode {formatVersion(newVersion)}</p>
        {#if previewRunning}
          <p class="restart-hint">Restart the preview to use the updated framework.</p>
        {/if}
        <div class="version-actions">
          <button class="btn-primary" onclick={() => onclose?.()}>Done</button>
        </div>
      </div>
    {:else}
      <div class="version-comparison">
        <div class="version-box">
          <span class="version-label">Course</span>
          <span class="version-value">{formatVersion(courseVersion)}</span>
          <span class="version-sublabel">{courseName}</span>
        </div>
        <div class="version-arrow">
          {#if upgradeAvailable}
            <Icon size={20}>
              <path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>
            </Icon>
          {:else}
            <Icon size={20}>
              <path d="M20 6 9 17l-5-5"/>
            </Icon>
          {/if}
        </div>
        <div class="version-box" class:highlight={upgradeAvailable}>
          <span class="version-label">Installed</span>
          <span class="version-value">{formatVersion(installedVersion)}</span>
          <span class="version-sublabel">Latest Published</span>
        </div>
      </div>

      {#if upgradeAvailable}
        <div class="upgrade-banner">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" class="banner-icon">
            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
            <path d="M12 8v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <circle cx="12" cy="16" r="1" fill="currentColor"/>
          </svg>
          <p>A newer version of CourseCode is available. Upgrading updates the framework dependency in this course project.</p>
        </div>
      {:else if upToDate}
        <div class="uptodate-banner">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" class="banner-icon">
            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
            <path d="M8 12l3 3 5-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <p>This course is using the latest version of CourseCode.</p>
        </div>
      {:else if !courseVersion}
        <div class="neutral-banner">
          <p>Version information is not available for this course.</p>
        </div>
      {:else if !installedVersion}
        <div class="neutral-banner">
          <p>The installed CourseCode version could not be determined.</p>
        </div>
      {/if}

      {#if upgradeError}
        <div class="upgrade-error">
          <p>{upgradeError}</p>
        </div>
      {/if}

      <div class="version-actions">
        <button class="btn-secondary" onclick={() => onclose?.()}>
          {upgradeAvailable ? 'Not Now' : 'Close'}
        </button>
        {#if upgradeAvailable}
          <button class="btn-primary" onclick={handleUpgrade} disabled={upgrading}>
            {#if upgrading}
              <div class="btn-spinner"></div>
              Upgrading…
            {:else if upgradeError}
              Try Again
            {:else}
              Upgrade Course
            {/if}
          </button>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .version-backdrop {
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

  .version-dialog {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: var(--sp-lg);
    width: 480px;
    max-width: calc(100vw - 48px);
    box-shadow: var(--shadow-lg);
    animation: scaleIn 150ms ease-out;
  }

  .version-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--sp-lg);
  }

  .version-title {
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--text-primary);
  }

  .version-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: var(--radius-sm);
    border: none;
    background: transparent;
    color: var(--text-tertiary);
    cursor: pointer;
    transition: background var(--duration-fast) var(--ease), color var(--duration-fast) var(--ease);
  }

  .version-close:hover {
    background: var(--bg-secondary);
    color: var(--text-primary);
  }

  /* --- Version comparison --- */
  .version-comparison {
    display: flex;
    align-items: center;
    gap: var(--sp-md);
    margin-bottom: var(--sp-lg);
  }

  .version-box {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: var(--sp-md);
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    transition: border-color var(--duration-fast) var(--ease);
  }

  .version-box.highlight {
    border-color: var(--accent);
    background: var(--accent-subtle);
  }

  .version-label {
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-tertiary);
  }

  .version-value {
    font-size: var(--text-xl);
    font-weight: 700;
    color: var(--text-primary);
    font-family: var(--font-mono);
  }

  .version-sublabel {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    max-width: 140px;
    text-align: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .version-arrow {
    flex-shrink: 0;
    color: var(--text-tertiary);
    display: flex;
    align-items: center;
  }

  /* --- Banners --- */
  .upgrade-banner {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-sm);
    padding: var(--sp-sm) var(--sp-md);
    background: var(--accent-subtle);
    border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
    border-radius: var(--radius-sm);
    margin-bottom: var(--sp-lg);
    color: var(--text-primary);
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  .upgrade-banner .banner-icon {
    flex-shrink: 0;
    color: var(--accent);
    margin-top: 1px;
  }

  .uptodate-banner {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-sm);
    padding: var(--sp-sm) var(--sp-md);
    background: var(--success-subtle);
    border: 1px solid color-mix(in srgb, var(--success) 30%, transparent);
    border-radius: var(--radius-sm);
    margin-bottom: var(--sp-lg);
    color: var(--text-primary);
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  .uptodate-banner .banner-icon {
    flex-shrink: 0;
    color: var(--success);
    margin-top: 1px;
  }

  .neutral-banner {
    padding: var(--sp-sm) var(--sp-md);
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    margin-bottom: var(--sp-lg);
    color: var(--text-secondary);
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  .upgrade-error {
    padding: var(--sp-sm) var(--sp-md);
    background: var(--error-subtle);
    border: 1px solid color-mix(in srgb, var(--error) 30%, transparent);
    border-radius: var(--radius-sm);
    margin-bottom: var(--sp-lg);
    color: var(--error);
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  /* --- Success state --- */
  .version-success {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-md);
    padding: var(--sp-lg) 0;
    text-align: center;
  }

  .success-icon {
    animation: scaleIn 200ms ease-out;
  }

  .success-text {
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--text-primary);
  }

  .restart-hint {
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }

  /* --- Actions --- */
  .version-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--sp-sm);
  }

  .version-actions button {
    padding: var(--sp-sm) var(--sp-md);
    font-size: var(--text-sm);
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
  }

  .btn-spinner {
    width: 14px;
    height: 14px;
    border: 2px solid rgba(255,255,255,0.3);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 600ms linear infinite;
    display: inline-block;
    vertical-align: middle;
    margin-right: 6px;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @keyframes scaleIn {
    from { opacity: 0; transform: scale(0.95); }
    to { opacity: 1; transform: scale(1); }
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
