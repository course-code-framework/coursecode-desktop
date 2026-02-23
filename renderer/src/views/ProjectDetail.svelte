<script>
  import { onMount, onDestroy } from 'svelte';
  import { settings } from '../stores/settings.js';
  import ChatPanel from './ChatPanel.svelte';
  import RefsPanel from './RefsPanel.svelte';
  import HistoryPanel from '../components/HistoryPanel.svelte';
  import OutlinePanel from './OutlinePanel.svelte';
  import EditorPanel from '../components/EditorPanel.svelte';
  import { openFileInEditor } from '../stores/editor.js';
  import { showToast } from '../stores/toast.js';
  import Icon from '../components/Icon.svelte';

  let { projectPath } = $props();

  let project = $state(null);
  let previewStatus = $state('stopped');
  let previewPort = $state(null);
  let consoleLines = $state([]);
  let building = $state(false);
  let deploying = $state(false);
  let deployPopoverOpen = $state(false);
  let deployReason = $state('');
  let deployBtnEl = $state(null);
  let startingPreview = $state(false);
  let refsExpanded = $state(false);
  let refCount = $state(0);
  let historyOpen = $state(false);
  let outlineOpen = $state(false);
  let rightTab = $state('preview'); // 'preview' | 'editor'
  let chatPanelVisible = $state(true);
  let previewFrameKey = $state(0);

  let unsubLog = null;
  let unsubBuild = null;
  let unsubOpenBrowser = null;

  onMount(async () => {
    project = await window.api.projects.open(projectPath);
    previewStatus = await window.api.preview.status(projectPath);
    previewPort = await window.api.preview.port(projectPath);
    chatPanelVisible = $settings.showAiChatByDefault !== false;

    // Load ref count
    try {
      const refs = await window.api.refs.list(projectPath);
      refCount = refs.length;
    } catch { /* refs unavailable */ }

    unsubLog = window.api.preview.onLog((data) => {
      if (data.projectPath === projectPath) addConsoleLine(data);
    });

    unsubBuild = window.api.build.onProgress((data) => {
      if (data.projectPath === projectPath) addConsoleLine(data);
    });

    unsubOpenBrowser = window.api.preview.onOpenInBrowser(() => {
      if (previewPort) window.open(`http://127.0.0.1:${previewPort}`);
    });

    // Always call startPreview here so we wait for readiness even if
    // a background/server process is already tracked as running.
    try {
      startingPreview = true;
      await startPreview({ openBrowser: false });
    } catch (err) {
      showToast({ type: 'error', message: `Failed to auto-start preview: ${err.message}` });
    } finally {
      startingPreview = false;
    }

    // Listen for openfile events from tool pills
    document.addEventListener('openfile', handleOpenFile);
    document.addEventListener('mousedown', handleDeployOutsideClick);
  });

  function handleOpenFile(e) {
    const filePath = e.detail?.path;
    if (filePath) {
      rightTab = 'editor';
      openFileInEditor(projectPath, filePath);
    }
  }

  onDestroy(() => {
    unsubLog?.();
    unsubBuild?.();
    unsubOpenBrowser?.();
    document.removeEventListener('openfile', handleOpenFile);
    document.removeEventListener('mousedown', handleDeployOutsideClick);
  });

  function addConsoleLine(data) {
    consoleLines = [...consoleLines.slice(-200), data];
  }



  async function startPreview(opts = {}) {
    addConsoleLine({ type: 'stdout', text: 'Starting preview server...\n' });
    const result = await window.api.preview.start(projectPath, opts);
    previewStatus = 'running';
    previewPort = result.port;
    // Force iframe remount so it retries load after server readiness.
    previewFrameKey += 1;
  }



  async function exportBuild() {
    building = true;
    consoleLines = [];
    addConsoleLine({ type: 'stdout', text: 'Building course...\n' });
    try {
      const result = await window.api.build.export(projectPath, project.format);
      addConsoleLine({ type: 'stdout', text: `\n✓ Build complete: ${result.zipPath}\n  Size: ${(result.size / 1024).toFixed(0)} KB | Time: ${(result.duration / 1000).toFixed(1)}s\n` });
      showToast({
        type: 'success',
        message: `Build complete — ${(result.size / 1024).toFixed(0)} KB`,
        action: { label: 'Reveal in Finder', handler: () => window.api.tools.openInFinder(result.zipPath) }
      });
    } catch (err) {
      addConsoleLine({ type: 'stderr', text: `\n✗ Build failed: ${err.message}\n` });
      showToast({ type: 'error', message: `Build failed: ${err.message}` });
    } finally {
      building = false;
    }
  }

  async function deploy() {
    deployPopoverOpen = false;
    deploying = true;
    consoleLines = [];
    try {
      const options = deployReason.trim() ? { message: deployReason.trim() } : undefined;
      const result = await window.api.cloud.deploy(projectPath, options);
      addConsoleLine({ type: 'stdout', text: `\n✓ Deployed: ${result.deployUrl}\n` });
      showToast({
        type: 'success',
        message: 'Deployed successfully!',
        action: result?.deployUrl ? { label: 'Open in Browser', handler: () => window.open(result.deployUrl) } : undefined
      });
    } catch (err) {
      addConsoleLine({ type: 'stderr', text: `\n✗ Deploy failed: ${err.message}\n` });
      showToast({ type: 'error', message: `Deploy failed: ${err.message}` });
    } finally {
      deploying = false;
      deployReason = '';
    }
  }

  function openDeployPopover() {
    if (deploying) return;
    deployPopoverOpen = !deployPopoverOpen;
    if (deployPopoverOpen) deployReason = '';
  }

  function handleDeployKeydown(e) {
    if (e.key === 'Escape') {
      deployPopoverOpen = false;
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      deploy();
    }
  }

  function handleDeployOutsideClick(e) {
    if (deployPopoverOpen && deployBtnEl && !deployBtnEl.contains(e.target)) {
      const popover = document.querySelector('.deploy-popover');
      if (popover && !popover.contains(e.target)) {
        deployPopoverOpen = false;
      }
    }
  }

  function handleRefCountUpdate(count) {
    refCount = count;
  }

  function toggleChatPanel() {
    chatPanelVisible = !chatPanelVisible;
  }
</script>

<div class="project-detail" data-testid="project-detail">
  <div class="toolbar">
    <div class="toolbar-group">
      <button class="tool-btn" onclick={exportBuild} disabled={building} title={building ? 'Building…' : 'Export'} data-testid="export-btn">
        <Icon>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </Icon>
      </button>

      <div class="deploy-wrapper" bind:this={deployBtnEl}>
        <button class="tool-btn" onclick={openDeployPopover} disabled={deploying} title={deploying ? 'Deploying…' : 'Deploy'} data-testid="deploy-btn">
          <Icon>
            <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/>
            <path d="M12 12v9"/>
            <path d="m16 16-4-4-4 4"/>
          </Icon>
        </button>

        {#if deployPopoverOpen}
          <div class="deploy-popover" role="dialog" aria-label="Deploy reason">
            <label class="deploy-popover-label" for="deploy-reason">Deploy reason <span class="optional-tag">optional</span></label>
            <input
              id="deploy-reason"
              type="text"
              class="deploy-popover-input"
              placeholder="e.g. Fixed quiz on slide 3"
              bind:value={deployReason}
              onkeydown={handleDeployKeydown}
            />
            <div class="deploy-popover-actions">
              <button class="deploy-popover-cancel" onclick={() => deployPopoverOpen = false}>Cancel</button>
              <button class="deploy-popover-confirm" onclick={deploy}>Deploy</button>
            </div>
          </div>
        {/if}
      </div>
    </div>

    <div class="toolbar-separator"></div>

    <div class="toolbar-group">
      <button class="tool-btn" class:active={outlineOpen} onclick={() => outlineOpen = !outlineOpen} title={outlineOpen ? 'Close Outline' : 'Course Outline'} data-testid="outline-btn">
        <Icon>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
          <polyline points="10 9 9 9 8 9"/>
        </Icon>
      </button>

      <button class="tool-btn" class:active={historyOpen} onclick={() => historyOpen = !historyOpen} title={historyOpen ? 'Close History' : 'History'} data-testid="history-btn">
        <Icon>
          <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
        </Icon>
      </button>
    </div>

    <div class="toolbar-separator"></div>

    <div class="toolbar-group">
      <button class="tool-btn" onclick={toggleChatPanel} class:active={chatPanelVisible} title={chatPanelVisible ? 'Hide AI chat panel' : 'Show AI chat panel'} data-testid="chat-toggle-btn">
        <Icon>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </Icon>
      </button>
    </div>

    <div class="toolbar-separator"></div>

    <div class="toolbar-group">
      <button class="tool-btn" onclick={() => window.api.tools.openInFinder(projectPath)} title={navigator.platform.includes('Mac') ? 'Reveal in Finder' : 'Open in Explorer'}>
        <Icon>
          <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 2H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2Z"/>
        </Icon>
      </button>

      <button class="tool-btn" onclick={() => window.api.tools.openTerminal(projectPath)} title="Open Terminal">
        <Icon>
          <polyline points="4 17 10 11 4 5"/>
          <line x1="12" x2="20" y1="19" y2="19"/>
        </Icon>
      </button>
    </div>

    <div class="toolbar-spacer"></div>

    <div class="toolbar-group">
      <div class="view-toggle">
        <button class="toggle-option" class:active={rightTab === 'preview'} onclick={() => rightTab = 'preview'} data-testid="tab-preview">Preview</button>
        <button class="toggle-option" class:active={rightTab === 'editor'} onclick={() => rightTab = 'editor'} data-testid="tab-editor">Editor</button>
      </div>
    </div>
  </div>

  <div class="workspace">
    {#if chatPanelVisible}
      <div class="workspace-left">
        <div class="refs-section" class:expanded={refsExpanded}>
          <button class="refs-toggle" onclick={() => refsExpanded = !refsExpanded}>
            <Icon size={12}>
              <path d="M4 3l4 3-4 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </Icon>
            <span>References</span>
            {#if refCount > 0}
              <span class="ref-count">{refCount}</span>
            {/if}
          </button>
          {#if refsExpanded}
            <div class="refs-content">
              <RefsPanel {projectPath} compact={true} onCountUpdate={handleRefCountUpdate} />
            </div>
          {/if}
        </div>

        <div class="chat-area">
          <ChatPanel
            {projectPath}
            refCount={refCount}
            onOpenRefs={() => { refsExpanded = true; }}
            onOpenOutline={() => { outlineOpen = true; }}
          />
        </div>
      </div>
    {/if}

    <div class="workspace-right">
      {#if rightTab === 'preview'}
        {#if previewPort}
          {#key `${previewPort}:${previewFrameKey}`}
            <iframe
              src={`http://127.0.0.1:${previewPort}`}
              title="Course Preview"
              class="preview-frame"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            ></iframe>
          {/key}
        {:else}
          <div class="preview-placeholder" data-testid="preview-placeholder">
            <span class="text-tertiary">{startingPreview ? 'Starting preview…' : 'Preview not available'}</span>
          </div>
        {/if}
      {:else}
        <EditorPanel {projectPath} />
      {/if}

      {#if outlineOpen}
        <div class="history-overlay">
          <OutlinePanel {projectPath} onClose={() => outlineOpen = false} />
        </div>
      {/if}

      {#if historyOpen}
        <div class="history-overlay">
          <HistoryPanel {projectPath} onClose={() => historyOpen = false} />
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .project-detail {
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── Compact Toolbar ── */
  .toolbar {
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
    padding: var(--sp-xs) var(--sp-md);
    height: var(--toolbar-height);
    border-bottom: 1px solid var(--border);
    background: var(--bg-elevated);
    flex-shrink: 0;
  }

  .toolbar-group {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .toolbar-separator {
    width: 1px;
    height: 18px;
    background: var(--border);
    margin: 0 var(--sp-xs);
  }

  .toolbar-spacer {
    flex: 1;
  }

  .tool-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: var(--radius-sm);
    border: none;
    background: none;
    color: var(--text-tertiary);
    cursor: pointer;
    transition: all var(--duration-fast) var(--ease);
  }

  .tool-btn:hover:not(:disabled) {
    background: var(--bg-secondary);
    color: var(--text-secondary);
  }

  .tool-btn:active:not(:disabled) {
    transform: scale(0.96);
  }

  .tool-btn.active {
    background: var(--accent-subtle);
    color: var(--accent);
  }

  .tool-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }


  /* ── Workspace (chat mode) ── */
  .workspace {
    flex: 1;
    display: flex;
    min-height: 0;
    overflow: hidden;
    animation: workspaceEnter 320ms var(--ease);
  }

  .workspace-left {
    flex: 0 1 clamp(340px, 36vw, 520px);
    min-width: 320px;
    max-width: 560px;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--border);
  }

  .workspace-right {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  /* ── Preview / Editor Toggle ── */
  .view-toggle {
    display: flex;
    background: var(--bg-secondary);
    border-radius: var(--radius-pill);
    padding: 2px;
    gap: 2px;
  }

  .toggle-option {
    padding: 3px 10px;
    border: none;
    background: none;
    color: var(--text-tertiary);
    font-size: var(--text-xs);
    font-weight: 500;
    cursor: pointer;
    border-radius: var(--radius-pill);
    transition: all var(--duration-fast) var(--ease);
    white-space: nowrap;
  }

  .toggle-option:hover {
    color: var(--text-secondary);
  }

  .toggle-option.active {
    background: var(--bg-elevated);
    color: var(--text-primary);
    box-shadow: var(--shadow-sm);
  }

  /* ── Refs Section (collapsible above chat) ── */
  .refs-section {
    flex-shrink: 0;
    border-bottom: 1px solid var(--border);
  }

  .refs-toggle {
    display: flex;
    align-items: center;
    gap: var(--sp-xs);
    width: 100%;
    padding: var(--sp-sm) var(--sp-md);
    border: none;
    background: var(--bg-elevated);
    color: var(--text-secondary);
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    cursor: pointer;
    transition: background var(--duration-fast) var(--ease);
  }

  .refs-toggle:hover {
    background: var(--bg-secondary);
  }

  .refs-toggle :global(svg) {
    transition: transform var(--duration-fast) var(--ease);
  }

  .refs-section.expanded .refs-toggle :global(svg) {
    transform: rotate(90deg);
  }

  .ref-count {
    margin-left: auto;
    padding: 1px 6px;
    border-radius: var(--radius-pill);
    background: var(--accent-subtle);
    color: var(--accent);
    font-size: var(--text-xs);
    font-weight: 600;
    line-height: 1.4;
  }

  .refs-content {
    max-height: 280px;
    overflow-y: auto;
    animation: refsReveal 180ms var(--ease);
  }

  /* ── Chat Area ── */
  .chat-area {
    flex: 1;
    min-height: 0;
  }

  /* ── Preview ── */
  .preview-frame {
    width: 100%;
    height: 100%;
    border: none;
    background: white;
  }

  .preview-placeholder {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  /* ── History Panel ── */
  .history-overlay {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 10;
    box-shadow: -4px 0 12px rgba(0, 0, 0, 0.1);
    animation: overlayIn 220ms var(--ease);
  }

  .workspace-right {
    position: relative;
  }

  @keyframes workspaceEnter {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  @keyframes refsReveal {
    from { opacity: 0; transform: translateY(-3px); }
    to { opacity: 1; transform: translateY(0); }
  }

  @keyframes overlayIn {
    from { opacity: 0; transform: translateX(10px); }
    to { opacity: 1; transform: translateX(0); }
  }

  @media (max-width: 1100px) {
    .workspace-left {
      flex-basis: clamp(320px, 42vw, 460px);
      min-width: 300px;
    }
  }

  @media (max-width: 900px) {
    .workspace {
      flex-direction: column;
    }

    .workspace-left {
      flex: 0 0 55%;
      min-width: 0;
      max-width: none;
      border-right: none;
      border-bottom: 1px solid var(--border);
    }

    .workspace-right {
      min-height: 45%;
    }

    .toolbar {
      height: auto;
      min-height: var(--toolbar-height);
      flex-wrap: wrap;
      row-gap: 4px;
    }

    .toolbar-spacer {
      display: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .workspace,
    .refs-content,
    .history-overlay {
      animation: none;
    }

    .tool-btn:hover:not(:disabled),
    .tool-btn:active:not(:disabled) {
      transform: none;
    }
  }
  /* ── Deploy Popover ── */
  .deploy-wrapper {
    position: relative;
  }

  .deploy-popover {
    position: absolute;
    top: calc(100% + 6px);
    left: 50%;
    transform: translateX(-50%);
    z-index: 100;
    width: 280px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
    padding: var(--sp-md);
    display: flex;
    flex-direction: column;
    gap: var(--sp-sm);
    animation: popoverIn 150ms var(--ease);
  }

  .deploy-popover-label {
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    gap: var(--sp-xs);
  }

  .optional-tag {
    font-weight: 400;
    color: var(--text-tertiary);
    font-style: italic;
  }

  .deploy-popover-input {
    width: 100%;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: var(--text-sm);
    outline: none;
    transition: border-color var(--duration-fast) var(--ease);
  }

  .deploy-popover-input:focus {
    border-color: var(--accent);
  }

  .deploy-popover-input::placeholder {
    color: var(--text-tertiary);
  }

  .deploy-popover-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }

  .deploy-popover-cancel,
  .deploy-popover-confirm {
    padding: 4px 12px;
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    font-weight: 500;
    cursor: pointer;
    border: none;
    transition: all var(--duration-fast) var(--ease);
  }

  .deploy-popover-cancel {
    background: var(--bg-secondary);
    color: var(--text-secondary);
  }

  .deploy-popover-cancel:hover {
    background: var(--bg-tertiary, var(--border));
  }

  .deploy-popover-confirm {
    background: var(--accent);
    color: var(--text-on-accent);
  }

  .deploy-popover-confirm:hover {
    background: var(--accent-hover);
  }

  @keyframes popoverIn {
    from { opacity: 0; transform: translateX(-50%) translateY(-4px); }
    to { opacity: 1; transform: translateX(-50%) translateY(0); }
  }
</style>
