<script>
  import { onMount } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import { settings } from '../stores/settings.js';
  import { refreshProjects } from '../stores/projects.js';

  let { onClose, onCreated, onOpenSetup = null } = $props();

  let step = $state(1);
  let name = $state('');
  let format = $state($settings.defaultFormat || 'cmi5');
  let layout = $state($settings.defaultLayout || 'article');
  let blank = $state(false);
  let location = $state($settings.projectsDir || '');
  let creating = $state(false);
  let error = $state(null);
  let showSetupCta = $state(false);
  let nameInputEl = $state(null);

  const formats = [
    { id: 'cmi5', label: 'cmi5', desc: 'Modern standard. Works with newer LMS platforms.', recommended: true },
    { id: 'scorm2004', label: 'SCORM 2004', desc: 'Widely supported. Works with most LMS platforms.' },
    { id: 'scorm1.2', label: 'SCORM 1.2', desc: 'Legacy standard. Use only if your LMS requires it.' },
    { id: 'lti', label: 'LTI', desc: 'Web standard for tool integration.' }
  ];

  const layouts = [
    { id: 'article', label: 'Article', desc: 'Scrolling document style, like a blog post.' },
    { id: 'traditional', label: 'Traditional', desc: 'Classic LMS layout with sidebar navigation.' },
    { id: 'presentation', label: 'Presentation', desc: 'Full-screen slides, like PowerPoint.' },
    { id: 'focused', label: 'Focused', desc: 'Immersive, distraction-free content.' }
  ];

  const nameValid = $derived(name.trim().length > 0 && !/[<>:"/\\|?*]/.test(name));

  // Shorten path for display: replace $HOME with ~
  const displayLocation = $derived(() => {
    const home = location.split('/').slice(0, 3).join('/'); // rough /Users/name
    return location.replace(home, '~');
  });

  async function pickLocation() {
    const folder = await window.api.dialog.pickFolder(location);
    if (folder) location = folder;
  }

  async function create() {
    creating = true;
    error = null;
    showSetupCta = false;
    try {
      const project = await window.api.projects.create({
        name: name.trim(),
        format,
        layout,
        blank,
        location: location || undefined
      });
      await refreshProjects();
      onCreated(project);
    } catch (err) {
      const message = err?.message || 'Failed to create course.';
      error = message;
      showSetupCta = message.includes('Open Setup Assistant');
      creating = false;
    }
  }

  function openSetupAssistant() {
    if (onOpenSetup) {
      onOpenSetup();
      return;
    }
    onClose?.();
  }

  onMount(() => {
    nameInputEl?.focus();
  });
</script>

<div class="wizard-overlay" data-testid="create-wizard">
  <div class="wizard">
    <div class="wizard-header">
      <h2>Create a New Course</h2>
      <button class="btn-icon btn-ghost" onclick={onClose} title="Close" data-testid="wizard-close-btn">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </button>
    </div>

    <div class="wizard-progress">
      {#each [1,2,3] as s}
        <div class="progress-step" class:active={step >= s} class:current={step === s}></div>
      {/each}
    </div>

    <div class="wizard-body">
      {#if creating}
        <div class="creating-state">
          <div class="loading-spinner large"></div>
          <h3>Creating your course...</h3>
          <p class="text-secondary">Setting things up. This may take a moment.</p>
        </div>
      {:else if step === 1}
        <div class="step" data-testid="wizard-step-1">
          <h3>Name Your Course</h3>
          <p class="text-secondary mt-sm">Choose a name and location for your course project.</p>
          <input
            bind:this={nameInputEl}
            type="text"
            bind:value={name}
            placeholder="My Awesome Course"
            class="name-input"
            data-testid="course-name-input"
            onkeydown={(e) => e.key === 'Enter' && nameValid && (step = 2)}
          />
          {#if name && !nameValid}
            <p class="error-text">Name cannot contain special characters: {'< > : " / \\ | ? *'}</p>
          {/if}

          <div class="location-row mt-lg">
            <span class="field-label">Location</span>
            <div class="location-picker">
              <span class="location-path">{displayLocation()}/{name || '...'}</span>
              <button class="btn-ghost btn-sm" onclick={pickLocation}>Browse…</button>
            </div>
          </div>

          <label class="checkbox-row mt-lg">
            <input type="checkbox" bind:checked={blank} />
            <span>Start blank</span>
            <span class="text-secondary text-sm">— no example slides</span>
          </label>
        </div>
      {:else if step === 2}
        <div class="step" data-testid="wizard-step-2">
          <h3>Pick a Format</h3>
          <p class="text-secondary mt-sm">Choose the LMS standard for your course.</p>
          <div class="option-grid">
            {#each formats as f}
              <button
                class="option-card"
                class:selected={format === f.id}
                onclick={() => format = f.id}
                data-testid={`format-${f.id}`}
              >
                <div class="option-header">
                  <span class="option-label">{f.label}</span>
                  {#if f.recommended}
                    <span class="badge badge-success">Recommended</span>
                  {/if}
                </div>
                <p class="option-desc">{f.desc}</p>
              </button>
            {/each}
          </div>
        </div>
      {:else if step === 3}
        <div class="step" data-testid="wizard-step-3">
          <h3>Pick a Layout</h3>
          <p class="text-secondary mt-sm">Choose how your course content is presented.</p>
          <div class="option-grid">
            {#each layouts as l}
              <button
                class="option-card"
                class:selected={layout === l.id}
                onclick={() => layout = l.id}
                data-testid={`layout-${l.id}`}
              >
                <div class="option-header">
                  <span class="option-icon" aria-hidden="true">
                    {#if l.id === 'article'}
                      <Icon size={18}>
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <path d="M14 2v6h6"/>
                        <path d="M8 13h8"/>
                        <path d="M8 17h8"/>
                        <path d="M8 9h3"/>
                      </Icon>
                    {:else if l.id === 'traditional'}
                      <Icon size={18}>
                        <rect x="3" y="4" width="18" height="16" rx="2"/>
                        <path d="M9 4v16"/>
                        <path d="M13 9h5"/>
                        <path d="M13 13h5"/>
                      </Icon>
                    {:else if l.id === 'presentation'}
                      <Icon size={18}>
                        <rect x="3" y="4" width="18" height="12" rx="2"/>
                        <path d="M8 20h8"/>
                        <path d="M12 16v4"/>
                      </Icon>
                    {:else}
                      <Icon size={18}>
                        <circle cx="12" cy="12" r="9"/>
                        <circle cx="12" cy="12" r="3"/>
                        <path d="M12 3v3"/>
                        <path d="M12 18v3"/>
                        <path d="M21 12h-3"/>
                        <path d="M6 12H3"/>
                      </Icon>
                    {/if}
                  </span>
                  <span class="option-label">{l.label}</span>
                </div>
                <p class="option-desc">{l.desc}</p>
              </button>
            {/each}
          </div>
          <div class="or-divider" aria-hidden="true">
            <span class="or-line"></span>
            <span class="or-label">or</span>
            <span class="or-line"></span>
          </div>
          <button
            class="canvas-option"
            class:selected={layout === 'canvas'}
            onclick={() => layout = 'canvas'}
            data-testid="layout-canvas"
          >
            <span class="canvas-label">Canvas</span>
            <span class="canvas-desc">Custom layout with JavaScript-powered CourseCode functions and bring-your-own CSS.</span>
          </button>
        </div>
      {/if}
    </div>

    {#if error}
      <div class="error-bar">
        <span class="error-message">{error}</span>
        <div class="error-actions">
          {#if showSetupCta}
            <button class="btn-ghost" onclick={openSetupAssistant} data-testid="wizard-open-setup-btn">
              Install/Repair Tools
            </button>
          {/if}
          <button class="btn-ghost" onclick={() => { error = null; showSetupCta = false; }}>Dismiss</button>
        </div>
      </div>
    {/if}

    {#if !creating}
      <div class="wizard-footer">
        <button class="btn-secondary" onclick={step > 1 ? () => step-- : onClose} data-testid="wizard-back-btn">
          {step > 1 ? 'Back' : 'Cancel'}
        </button>
        {#if step < 3}
          <button class="btn-primary" disabled={step === 1 && !nameValid} onclick={() => step++} data-testid="wizard-continue-btn">
            Continue
          </button>
        {:else}
          <button class="btn-primary" onclick={create} data-testid="wizard-create-btn">
            Create Course
          </button>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .wizard-overlay {
    position: fixed;
    inset: 0;
    background: var(--bg-overlay);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
    padding: var(--sp-xl);
  }

  .wizard {
    background: var(--bg-elevated);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    width: 100%;
    max-width: 560px;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .wizard-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--sp-lg) var(--sp-xl);
    border-bottom: 1px solid var(--border);
  }

  .wizard-progress {
    display: flex;
    gap: var(--sp-sm);
    padding: var(--sp-md) var(--sp-xl);
  }

  .progress-step {
    flex: 1;
    height: 3px;
    border-radius: var(--radius-pill);
    background: var(--border);
    transition: background var(--duration-normal) var(--ease);
  }

  .progress-step.active {
    background: var(--accent);
  }

  .wizard-body {
    flex: 1;
    padding: var(--sp-lg) var(--sp-xl);
    overflow-y: auto;
  }

  .wizard-footer {
    display: flex;
    justify-content: space-between;
    padding: var(--sp-lg) var(--sp-xl);
    border-top: 1px solid var(--border);
  }

  .name-input {
    margin-top: var(--sp-lg);
    font-size: var(--text-lg);
    padding: var(--sp-md);
  }

  .field-label {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-secondary);
    margin-bottom: var(--sp-xs);
    display: block;
  }

  .location-picker {
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
    padding: var(--sp-sm) var(--sp-md);
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }

  .location-path {
    flex: 1;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
  }

  .checkbox-row {
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
    cursor: pointer;
  }

  .checkbox-row input[type="checkbox"] {
    width: 16px;
    height: 16px;
    accent-color: var(--accent);
  }

  .option-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--sp-md);
    margin-top: var(--sp-lg);
  }

  .option-card {
    text-align: left;
    padding: var(--sp-md);
    background: var(--bg-primary);
    border: 2px solid var(--border);
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: all var(--duration-fast) var(--ease);
    display: flex;
    flex-direction: column;
    gap: var(--sp-sm);
  }

  .option-card:hover {
    border-color: var(--accent);
  }

  .option-card.selected {
    border-color: var(--border-strong);
    background: var(--bg-secondary);
    box-shadow: inset 0 0 0 1px rgba(241, 135, 1, 0.2);
  }

  .option-header {
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
  }

  .option-icon {
    display: inline-flex;
    align-items: center;
    color: var(--text-secondary);
  }

  .option-label {
    font-weight: 600;
    color: var(--text-primary);
  }

  .option-desc {
    font-size: var(--text-sm);
    color: var(--text-secondary);
    line-height: 1.4;
  }

  .or-divider {
    margin-top: var(--sp-lg);
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
    color: var(--text-tertiary);
  }

  .or-line {
    flex: 1;
    height: 1px;
    background: var(--border);
  }

  .or-label {
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .canvas-option {
    margin-top: var(--sp-md);
    width: 100%;
    text-align: left;
    padding: var(--sp-md);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: all var(--duration-fast) var(--ease);
    display: flex;
    flex-direction: column;
    gap: var(--sp-xs);
  }

  .canvas-option:hover {
    border-color: var(--accent);
  }

  .canvas-option.selected {
    border-color: var(--border-strong);
    background: var(--bg-secondary);
    box-shadow: inset 0 0 0 1px rgba(241, 135, 1, 0.2);
  }

  .canvas-label {
    font-weight: 600;
    color: var(--text-primary);
  }

  .canvas-desc {
    font-size: var(--text-sm);
    line-height: 1.4;
    color: var(--text-secondary);
  }

  .creating-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: var(--sp-2xl);
    gap: var(--sp-md);
    text-align: center;
  }

  .loading-spinner.large {
    width: 48px;
    height: 48px;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .error-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-sm);
    padding: var(--sp-sm) var(--sp-xl);
    background: var(--error-subtle);
    color: var(--error);
    font-size: var(--text-sm);
  }

  .error-message {
    flex: 1;
    min-width: 0;
  }

  .error-actions {
    display: flex;
    align-items: center;
    gap: var(--sp-xs);
  }

  .error-text {
    color: var(--error);
    font-size: var(--text-sm);
    margin-top: var(--sp-sm);
  }
</style>
