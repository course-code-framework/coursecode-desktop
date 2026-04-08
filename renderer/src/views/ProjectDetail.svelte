<script>
  import { onMount, onDestroy } from 'svelte';
  import { settings, updateSetting } from '../stores/settings.js';
  import ChatPanel from './ChatPanel.svelte';
  import RefsPanel from './RefsPanel.svelte';
  import OutlinePanel from './OutlinePanel.svelte';
  import EditorPanel from '../components/EditorPanel.svelte';
  import ConfirmDialog from '../components/ConfirmDialog.svelte';
  import { openFileInEditor } from '../stores/editor.js';
  import { showToast } from '../stores/toast.js';
  import { popover } from '../actions/popover.js';
  import { user } from '../stores/auth.js';
  import { marked } from 'marked';
  import Icon from '../components/Icon.svelte';
  import DeployProgressDialog from '../components/DeployProgressDialog.svelte';
  import { getDisplayErrorMessage } from '../lib/errors.js';

  let { projectPath } = $props();

  let project = $state(null);
  let previewStatus = $state('stopped');
  let previewPort = $state(null);
  let consoleLines = $state([]);
  let building = $state(false);
  let deploying = $state(false);
  let deployPopoverOpen = $state(false);
  let deployReason = $state('');
  let deployPromote = $state(false);
  let deployPreview = $state(false);
  let deployBtnEl = $state(null);
  let startingPreview = $state(false);
  let exportPopoverOpen = $state(false);
  let exportFormat = $state('');
  let exportBtnEl = $state(null);
  let refsExpanded = $state(false);
  let refCount = $state(0);
  let outlineOpen = $state(false);
  let refViewerOpen = $state(false);
  let refViewerFilename = $state('');
  let refViewerContent = $state('');
  let rightTab = $state('preview'); // 'preview' | 'editor'
  let chatPanelVisible = $state(true);
  let chatReloadKey = $state(0);
  let previewFrameKey = $state(0);
  let cloudStatus = $state(null);
  let staleBindingPrompt = $state(null);
  let checkedBindingKey = $state('');
  let checkingBinding = $state(false);
  let cloudStatusInterval = null;
  let deployProgress = $state(null);

  let unsubLog = null;
  let unsubBuild = null;
  let unsubOpenBrowser = null;
  let unsubDeployProgress = null;

  onMount(async () => {
    project = await window.api.projects.open(projectPath);
    previewStatus = await window.api.preview.status(projectPath);
    previewPort = await window.api.preview.port(projectPath);
    chatPanelVisible = $settings.aiChatEnabled === true;

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

    unsubDeployProgress = window.api.cloud.onDeployProgress((data) => {
      if (data?.projectPath !== projectPath) return;
      handleDeployProgress(data);
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
    document.addEventListener('mousedown', handleExportOutsideClick);

    await refreshCloudStatus();
    cloudStatusInterval = setInterval(refreshCloudStatus, 60000);
  });

  async function handleOpenFile(e) {
    const filePath = e.detail?.path;
    if (filePath) {
      rightTab = 'editor';
      try {
        await openFileInEditor(projectPath, filePath);
      } catch (err) {
        showToast({ type: 'error', message: `Unable to open file: ${err?.message || filePath}` });
      }
    }
  }

  onDestroy(() => {
    unsubLog?.();
    unsubBuild?.();
    unsubOpenBrowser?.();
    unsubDeployProgress?.();
    document.removeEventListener('openfile', handleOpenFile);
    document.removeEventListener('mousedown', handleDeployOutsideClick);
    document.removeEventListener('mousedown', handleExportOutsideClick);
    if (cloudStatusInterval) clearInterval(cloudStatusInterval);
  });

  $effect(() => {
    if (!$user || !project?.cloudId || staleBindingPrompt || checkingBinding) return;
    const nextKey = `${project.path}:${project.cloudId}`;
    if (checkedBindingKey === nextKey) return;
    checkLinkedCloudStatus(nextKey);
  });

  function addConsoleLine(data) {
    consoleLines = [...consoleLines.slice(-200), data];
  }

  async function reloadProject() {
    project = await window.api.projects.open(projectPath);
    await refreshCloudStatus();
  }

  async function handleSnapshotRestored() {
    await reloadProject();
    chatReloadKey += 1;
    showToast({ type: 'success', message: 'Project and chat context restored.' });
  }

  async function checkLinkedCloudStatus(bindingKey) {
    checkingBinding = true;
    try {
      const status = await window.api.cloud.getDeployStatus(projectPath);
      if (!status) return;
      checkedBindingKey = bindingKey;
      if (status?.errorCode === 'stale_cloud_binding') {
        staleBindingPrompt = {
          message: `"${project.title || project.name}" is still linked to a CourseCode Cloud course that no longer exists.`
        };
      }
    } finally {
      checkingBinding = false;
    }
  }

  async function refreshCloudStatus() {
    if (!$user || !project?.cloudId) {
      cloudStatus = null;
      return;
    }

    try {
      const status = await window.api.cloud.getDeployStatus(projectPath);
      if (status?.errorCode === 'stale_cloud_binding') {
        staleBindingPrompt = {
          message: `"${project.title || project.name}" is still linked to a CourseCode Cloud course that no longer exists.`
        };
        return;
      }
      cloudStatus = status;
      // Detect GitHub-linked courses from the status response
      const isGithub = status?.source?.type === 'github' || status?.source_type === 'github';
      if (project && project.githubLinked !== isGithub) {
        project = { ...project, githubLinked: isGithub || undefined };
      }
    } catch {
      cloudStatus = null;
    }
  }

  function getCloudPreviewState() {
    return cloudStatus?.previewLink?.state || null;
  }

  function getCloudPreviewLabel() {
    const state = getCloudPreviewState();
    if (!state) return null;
    if (state === 'active') return 'Preview Live';
    if (state === 'disabled') return 'Preview Off';
    if (state === 'expired') return 'Preview Expired';
    if (state === 'missing') return 'No Preview';
    return 'Preview';
  }

  function setDeployProgress(nextValue) {
    deployProgress = nextValue;
  }

  function clearDeployProgress() {
    deployProgress = null;
  }

  function getDeployTargetLabel(repairBinding = false, overrides = {}) {
    const preview = Object.prototype.hasOwnProperty.call(overrides, 'preview') ? overrides.preview : deployPreview;
    const promote = Object.prototype.hasOwnProperty.call(overrides, 'promote') ? overrides.promote : deployPromote;
    if (repairBinding && preview) return 'Repairing link and updating preview';
    if (preview) return 'Updating cloud preview';
    if (repairBinding) return 'Repairing cloud link';
    if (promote) return 'Deploying to production';
    if (project?.githubLinked) return 'Updating cloud preview';
    return 'Deploying to CourseCode Cloud';
  }

  function hasExistingCloudDeployment() {
    return !!project?.cloudId;
  }

  function canShowProductionUpdate() {
    return hasExistingCloudDeployment() && !project?.githubLinked;
  }

  function getPreviewToggleLabel() {
    return hasExistingCloudDeployment() ? 'Preview Link On' : 'Also Turn On Preview';
  }

  function getPreviewToggleCopy() {
    const currentState = getCloudPreviewState();
    if (!hasExistingCloudDeployment()) {
      return deployPreview
        ? 'Create a preview link and include it when this first deploy finishes.'
        : 'Deploy without creating a cloud preview link.';
    }

    if (deployPreview) {
      return currentState === 'active'
        ? 'Keep preview on and move it to this latest version.'
        : 'Turn preview on and point it to this version.';
    }

    return currentState === 'active'
      ? 'Turn preview off after this deploy completes.'
      : 'Leave preview off.';
  }

  function getPreviewPanelCopy() {
    if (getCloudPreviewState() === 'active') {
      return hasExistingCloudDeployment()
        ? 'The preview URL is live and can stay synced to the latest deployed version.'
        : 'The preview URL is live. You can publish this first deploy there too.';
    }
    if (getCloudPreviewState() === 'expired') {
      return hasExistingCloudDeployment()
        ? 'The preview URL expired. Turn it back on if you want preview to resume tracking new deploys.'
        : 'The preview URL expired. Turn it back on before publishing this first deploy there.';
    }
    if (getCloudPreviewState() === 'disabled') {
      return hasExistingCloudDeployment()
        ? 'The preview URL is off. Turn it on if you want preview to track this deploy.'
        : 'The preview URL is off. Turn it on to publish a preview URL with this deploy.';
    }
    return hasExistingCloudDeployment()
      ? 'No preview URL exists yet. Turn it on to create one.'
      : 'No preview URL exists yet. Turn it on to create one for this deploy.';
  }

  function canShowPreviewOpenAction() {
    return hasExistingCloudDeployment() && getCloudPreviewState() === 'active';
  }

  function beginDeployProgress(repairBinding = false, overrides = {}) {
    clearDeployProgress();
    setDeployProgress({
      active: true,
      stage: 'building',
      message: 'Preparing deployment...',
      targetLabel: getDeployTargetLabel(repairBinding, overrides),
      dashboardUrl: '',
      previewUrl: ''
    });
  }

  function handleDeployProgress(data) {
    if (data.log) addConsoleLine({ type: 'stdout', text: data.log });

    setDeployProgress({
      ...(deployProgress || {}),
      active: deployProgress?.active ?? true,
      stage: data.stage || deployProgress?.stage || 'building',
      message: data.message || deployProgress?.message || 'Preparing deployment...',
      targetLabel: deployProgress?.targetLabel || 'Deploying to CourseCode Cloud'
    });
  }

  function openCloudPreview() {
    const url = cloudStatus?.previewLink?.url;
    if (url) window.open(url);
  }

  function canUpdatePreviewPointer() {
    return getCloudPreviewState() === 'active';
  }

  function isPreviewLinkBusy() {
    return deploying === 'preview-link';
  }

  async function setPreviewLinkState(enabled, { autoSelectPreview = false } = {}) {
    deploying = 'preview-link';
    try {
      const previewLink = cloudStatus?.previewLink;
      const options = enabled ? { enable: true } : { disable: true };
      if (enabled && (!previewLink?.exists || previewLink?.state === 'expired')) {
        options.expiresInDays = 7;
      }

      await window.api.cloud.updatePreviewLink(projectPath, options);
      await refreshCloudStatus();

      if (enabled && autoSelectPreview) {
        deployPreview = true;
      } else if (!enabled) {
        deployPreview = false;
      }

      showToast({
        type: 'success',
        message: enabled ? 'Preview link enabled.' : 'Preview link disabled.'
      });
    } catch (err) {
      showToast({ type: 'error', message: `Preview link update failed: ${err.message}` });
    } finally {
      deploying = false;
    }
  }



  async function startPreview(opts = {}) {
    addConsoleLine({ type: 'stdout', text: 'Starting preview server...\n' });
    const result = await window.api.preview.start(projectPath, opts);
    previewStatus = 'running';
    previewPort = result.port;
    // Force iframe remount so it retries load after server readiness.
    previewFrameKey += 1;
  }



  const FORMAT_LABELS = { cmi5: 'cmi5', scorm2004: 'SCORM 2004', 'scorm1.2': 'SCORM 1.2', lti: 'LTI' };
  const FORMATS = Object.keys(FORMAT_LABELS);

  function openExportPopover() {
    if (building) return;
    exportPopoverOpen = !exportPopoverOpen;
    if (exportPopoverOpen) {
      exportFormat = project?.format || 'cmi5';
    }
  }

  function handleExportOutsideClick(e) {
    if (exportPopoverOpen && exportBtnEl && !exportBtnEl.contains(e.target)) {
      const popover = exportBtnEl.querySelector('.export-popover');
      if (!popover || !popover.contains(e.target)) {
        exportPopoverOpen = false;
      }
    }
  }

  async function exportBuild() {
    exportPopoverOpen = false;
    const format = exportFormat || project?.format || 'cmi5';
    const courseName = (project?.title || 'course').replace(/[<>:"/\\|?*]/g, '-').replace(/\s+/g, '_').toLowerCase();
    const defaultName = `${courseName}_${format}.zip`;

    // Open save dialog first
    const savePath = await window.api.dialog.saveFile(defaultName);
    if (!savePath) return; // user cancelled

    building = true;
    consoleLines = [];
    addConsoleLine({ type: 'stdout', text: `Building course (${FORMAT_LABELS[format] || format})...\n` });
    try {
      const result = await window.api.build.export(projectPath, format, savePath);
      const filename = savePath.split('/').pop() || savePath.split('\\').pop();
      addConsoleLine({ type: 'stdout', text: `\n✓ Exported: ${filename}\n  Size: ${(result.size / 1024).toFixed(0)} KB | Time: ${(result.duration / 1000).toFixed(1)}s\n` });
      showToast({
        type: 'success',
        message: `Exported — ${filename} (${(result.size / 1024).toFixed(0)} KB)`,
        action: { label: 'Open Folder', handler: () => window.api.tools.openInFinder(result.savedPath || result.zipPath) }
      });
    } catch (err) {
      addConsoleLine({ type: 'stderr', text: `\n✗ Export failed: ${err.message}\n` });
      showToast({ type: 'error', message: `Export failed: ${err.message}` });
    } finally {
      building = false;
    }
  }

  function getDeployOptions(repairBinding = false, overrides = {}) {
    const options = {};
    const message = Object.prototype.hasOwnProperty.call(overrides, 'message') ? overrides.message : deployReason.trim();
    const promote = Object.prototype.hasOwnProperty.call(overrides, 'promote') ? overrides.promote : deployPromote;
    const preview = Object.prototype.hasOwnProperty.call(overrides, 'preview') ? overrides.preview : deployPreview;
    if (message) options.message = message;
    if (promote) options.promote = true;
    if (preview) options.preview = true;
    if (repairBinding) options.repairBinding = true;
    return Object.keys(options).length ? options : undefined;
  }

  async function deploy(repairBinding = false, overrides = {}) {
    deployPopoverOpen = false;
    deploying = true;
    beginDeployProgress(repairBinding, overrides);
    consoleLines = [];
    const desiredPreviewEnabled = Object.prototype.hasOwnProperty.call(overrides, 'preview') ? !!overrides.preview : deployPreview;
    const initialPreviewState = getCloudPreviewState();
    let enabledPreviewForAttempt = false;
    try {
      if (desiredPreviewEnabled && initialPreviewState !== 'active' && hasExistingCloudDeployment()) {
        setDeployProgress({
          ...(deployProgress || {}),
          message: 'Turning on preview link...'
        });
        const previewLink = cloudStatus?.previewLink;
        const enableOptions = { enable: true };
        if (!previewLink?.exists || previewLink?.state === 'expired') enableOptions.expiresInDays = 7;
        await window.api.cloud.updatePreviewLink(projectPath, enableOptions);
        enabledPreviewForAttempt = true;
        await refreshCloudStatus();
      }

      const result = await window.api.cloud.deploy(projectPath, getDeployOptions(repairBinding, overrides));
      if (!desiredPreviewEnabled && initialPreviewState === 'active' && hasExistingCloudDeployment()) {
        setDeployProgress({
          ...(deployProgress || {}),
          message: 'Turning off preview link...'
        });
        await window.api.cloud.updatePreviewLink(projectPath, { disable: true });
        await refreshCloudStatus();
      }
      const previewUrl = desiredPreviewEnabled
        ? (result?.previewUrl || cloudStatus?.previewLink?.url || null)
        : null;
      addConsoleLine({ type: 'stdout', text: `\n✓ Deployed${result.dashboardUrl ? ': ' + result.dashboardUrl : ''}\n` });
      const actions = [];
      if (result?.dashboardUrl) actions.push({ label: 'Open in Cloud', handler: () => window.open(result.dashboardUrl) });
      if (previewUrl) actions.push({ label: 'Open Preview', handler: () => window.open(previewUrl) });
      showToast({
        type: 'success',
        message: repairBinding
          ? (overrides.preview ? 'Cleared the missing cloud link and updated the preview deployment.' : 'Cleared the missing cloud link and redeployed.')
          : 'Deployed to CourseCode Cloud!',
        actions,
        duration: 8000
      });
      setDeployProgress({
        ...(deployProgress || {}),
        active: false,
        stage: 'complete',
        message: previewUrl ? 'Deployment finished. You can open the preview or cloud dashboard below.' : 'Deployment finished. You can review it in CourseCode Cloud.',
        targetLabel: deployProgress?.targetLabel || getDeployTargetLabel(repairBinding, overrides),
        dashboardUrl: result?.dashboardUrl || '',
        previewUrl: previewUrl || ''
      });
      await reloadProject();
      await refreshCloudStatus();
      resetDeployOptions();
    } catch (err) {
      if (enabledPreviewForAttempt) {
        try {
          await window.api.cloud.updatePreviewLink(projectPath, { disable: true });
          await refreshCloudStatus();
        } catch {
          // Best effort rollback when deploy never completed.
        }
      }
      setDeployProgress({
        ...(deployProgress || {}),
        active: false,
        stage: 'error',
        message: err?.code === 'STALE_CLOUD_BINDING'
          ? 'This project still points to a deleted CourseCode Cloud course.'
          : `Deploy failed: ${err.message}`,
        targetLabel: deployProgress?.targetLabel || getDeployTargetLabel(repairBinding, overrides),
        dashboardUrl: '',
        previewUrl: ''
      });
      if (err?.code === 'STALE_CLOUD_BINDING') {
        staleBindingPrompt = err;
        addConsoleLine({
          type: 'stderr',
          text: '\n! This project is still linked to a deleted CourseCode Cloud course.\n'
        });
        return;
      }
      addConsoleLine({ type: 'stderr', text: `\n✗ Deploy failed: ${err.message}\n` });
      showToast({ type: 'error', message: `Deploy failed: ${getDisplayErrorMessage(err)}` });
      resetDeployOptions();
    } finally {
      deploying = false;
    }
  }

  function resetDeployOptions() {
    deployReason = '';
    deployPromote = false;
    deployPreview = getCloudPreviewState() === 'active';
  }

  function dismissStaleBindingPrompt() {
    staleBindingPrompt = null;
    resetDeployOptions();
  }

  async function confirmRepairDeploy() {
    staleBindingPrompt = null;
    await deploy(
      true,
      project?.githubLinked ? { preview: true, promote: false } : { preview: getCloudPreviewState() === 'active' }
    );
    resetDeployOptions();
  }

  async function clearStaleBindingOnly() {
    staleBindingPrompt = null;
    deploying = true;
    consoleLines = [];
    try {
      await window.api.projects.clearCloudBinding(projectPath);
      addConsoleLine({
        type: 'stdout',
        text: '\n✓ Cleared the old cloud link. This project is no longer deployed.\n'
      });
      await reloadProject();
      await refreshCloudStatus();
      showToast({
        type: 'success',
        message: 'Cloud link cleared. This course is no longer deployed.'
      });
    } catch (err) {
      addConsoleLine({ type: 'stderr', text: `\n✗ Clear link failed: ${err.message}\n` });
      showToast({ type: 'error', message: `Clear link failed: ${err.message}` });
    } finally {
      deploying = false;
      resetDeployOptions();
    }
  }

  function openDeployPopover() {
    if (deploying) return;
    if (!$user) {
      showToast({ type: 'warning', message: 'Sign in to CourseCode Cloud to deploy. Go to Settings → Cloud Account.' });
      return;
    }
    deployPopoverOpen = !deployPopoverOpen;
    if (deployPopoverOpen) {
      resetDeployOptions();
    }
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

  async function toggleChatPanel() {
    const nextVisible = !chatPanelVisible;
    chatPanelVisible = nextVisible;
    try {
      await updateSetting('aiChatEnabled', nextVisible);
    } catch {
      chatPanelVisible = !nextVisible;
      showToast({ type: 'error', message: 'Failed to save AI chat visibility preference.' });
    }
  }
</script>

<div class="project-detail" data-testid="project-detail">
  <div class="toolbar">
    <div class="toolbar-group">
      <div class="export-wrapper" bind:this={exportBtnEl}>
        <button class="tool-btn" onclick={openExportPopover} disabled={building} title={building ? 'Building…' : 'Export'} data-testid="export-btn">
          <Icon>
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </Icon>
        </button>

        {#if exportPopoverOpen}
          <div class="export-popover" role="dialog" aria-label="Export options" use:popover>
            <div class="deploy-popover-field">
              <label class="deploy-popover-label">Format</label>
              <select class="export-format-select" bind:value={exportFormat}>
                {#each FORMATS as fmt}
                  <option value={fmt}>{FORMAT_LABELS[fmt]}</option>
                {/each}
              </select>
            </div>
            <div class="deploy-popover-actions">
              <button class="deploy-popover-cancel" onclick={() => exportPopoverOpen = false}>Cancel</button>
              <button class="deploy-popover-confirm" onclick={exportBuild}>Export</button>
            </div>
          </div>
        {/if}
      </div>

      <div class="deploy-wrapper" bind:this={deployBtnEl}>
        <button
          class="tool-btn"
          onclick={openDeployPopover}
          disabled={!!deploying || !$user}
          title={$user ? (deploying ? (deployProgress?.message || 'Deploying...') : (project?.githubLinked ? 'Deployed via GitHub — push to your repo to deploy' : 'Deploy')) : 'Sign in to deploy'}
          data-testid="deploy-btn"
        >
          <Icon>
            <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/>
            <path d="M12 12v9"/>
            <path d="m16 16-4-4-4 4"/>
          </Icon>
        </button>

      </div>

      {#if project?.cloudId && getCloudPreviewLabel()}
        <span
          class="toolbar-status-badge"
          class:active={getCloudPreviewState() === 'active'}
          class:disabled={getCloudPreviewState() === 'disabled'}
          class:expired={getCloudPreviewState() === 'expired'}
          class:missing={getCloudPreviewState() === 'missing'}
          title={cloudStatus?.previewLink?.url || 'Cloud preview status'}
        >
          {getCloudPreviewLabel()}
        </span>
      {/if}

      {#if getCloudPreviewState() === 'active'}
        <button class="tool-btn" onclick={openCloudPreview} title="Open Cloud preview">
          <Icon>
            <path d="M2 12s3.5-5 10-5 10 5 10 5-3.5 5-10 5S2 12 2 12Z"/>
            <circle cx="12" cy="12" r="3"/>
          </Icon>
        </button>
      {/if}
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
      <button class="tool-btn" onclick={() => window.api.tools.openCourseFolder(projectPath)} title={navigator.platform.includes('Mac') ? 'Open Course Folder in Finder' : 'Open Course Folder in Explorer'}>
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

  {#if deployProgress}
    <DeployProgressDialog
      active={deployProgress.active ?? !!deploying}
      stage={deployProgress.stage || 'building'}
      message={deployProgress.message || 'Preparing deployment...'}
      targetLabel={deployProgress.targetLabel || getDeployTargetLabel()}
      dashboardUrl={deployProgress.dashboardUrl || ''}
      previewUrl={deployProgress.previewUrl || ''}
      onclose={clearDeployProgress}
    />
  {/if}

  {#if deployPopoverOpen}
    <div class="deploy-dialog-backdrop" role="presentation" onclick={() => deployPopoverOpen = false}>
      {#if project?.githubLinked}
        <div class="deploy-popover deploy-dialog-panel" role="dialog" aria-modal="true" aria-label="GitHub deploy info" onclick={(e) => e.stopPropagation()}>
          <p class="deploy-toggle-tip">Production deploys are managed by your GitHub repository. Push to deploy.</p>
          <div class="preview-link-panel">
            <div class="preview-link-header">
              <span class="preview-link-title">Preview Link</span>
              <span class="preview-link-state" class:active={getCloudPreviewState() === 'active'} class:disabled={getCloudPreviewState() === 'disabled'} class:expired={getCloudPreviewState() === 'expired'} class:missing={getCloudPreviewState() === 'missing'}>{getCloudPreviewLabel() || 'Checking…'}</span>
            </div>
            <p class="preview-link-copy">
              {#if getCloudPreviewState() === 'active'}
                Stakeholders can open the cloud preview now.
              {:else if getCloudPreviewState() === 'expired'}
                The preview link expired. Turn it back on before deploying a new preview pointer.
              {:else if getCloudPreviewState() === 'disabled'}
                The preview link is off. Turn it on to publish a preview URL.
              {:else}
                No preview link exists yet. Turn it on to create one.
              {/if}
            </p>
            <div class="preview-link-actions">
              <button class="preview-link-btn" disabled={isPreviewLinkBusy()} onclick={() => setPreviewLinkState(getCloudPreviewState() !== 'active', { autoSelectPreview: true })}>
                {#if isPreviewLinkBusy()}
                  <div class="btn-spinner"></div>
                {:else if getCloudPreviewState() === 'active'}
                  Turn Off Preview
                {:else}
                  Turn On Preview
                {/if}
              </button>
              {#if getCloudPreviewState() === 'active'}
                <button class="preview-link-btn subtle" onclick={openCloudPreview}>Open Link</button>
              {/if}
            </div>
          </div>
          <p class="deploy-toggle-tip">You can still update the preview link directly from Desktop.</p>
          <div class="deploy-popover-actions">
            <button class="deploy-popover-cancel" onclick={() => deployPopoverOpen = false}>Dismiss</button>
            <button class="deploy-popover-confirm" disabled={!canUpdatePreviewPointer() || isPreviewLinkBusy()} onclick={() => deploy(false, { preview: true, promote: false })}>Deploy Preview</button>
          </div>
        </div>
      {:else}
        <div class="deploy-popover deploy-dialog-panel" role="dialog" aria-modal="true" aria-label="Deploy options" onclick={(e) => e.stopPropagation()}>
          <div class="deploy-popover-field">
            <label class="deploy-popover-label" for="deploy-reason">Reason <span class="optional-tag">optional</span></label>
            <input
              id="deploy-reason"
              type="text"
              class="deploy-popover-input"
              placeholder="e.g. Fixed quiz on slide 3"
              bind:value={deployReason}
              onkeydown={handleDeployKeydown}
            />
          </div>
          {#if canShowProductionUpdate()}
            <div class="deploy-toggle-row">
              <label class="deploy-toggle-label">
                <input type="checkbox" bind:checked={deployPromote} />
                <span>Update Production</span>
              </label>
              <span class="deploy-toggle-tip">Go live now. Overrides your Cloud deploy mode setting.</span>
            </div>
          {/if}
          <div class="deploy-toggle-row">
            <label class="deploy-toggle-label">
              <input type="checkbox" bind:checked={deployPreview} />
              <span>{getPreviewToggleLabel()}</span>
            </label>
            <span class="deploy-toggle-tip">{getPreviewToggleCopy()}</span>
          </div>
          {#if hasExistingCloudDeployment()}
          <div class="preview-link-panel compact">
            <div class="preview-link-header">
              <span class="preview-link-title">Preview Link</span>
              <span class="preview-link-state" class:active={getCloudPreviewState() === 'active'} class:disabled={getCloudPreviewState() === 'disabled'} class:expired={getCloudPreviewState() === 'expired'} class:missing={getCloudPreviewState() === 'missing'}>{getCloudPreviewLabel() || 'Checking…'}</span>
            </div>
            <p class="preview-link-copy">{getPreviewPanelCopy()}</p>
            {#if canShowPreviewOpenAction()}
              <div class="preview-link-actions">
                <button class="preview-link-btn subtle" onclick={openCloudPreview}>Open Link</button>
              </div>
            {/if}
          </div>
          {/if}
          <div class="deploy-popover-actions">
            <button class="deploy-popover-cancel" onclick={() => deployPopoverOpen = false}>Cancel</button>
            <button class="deploy-popover-confirm" onclick={deploy}>Deploy</button>
          </div>
        </div>
      {/if}
    </div>
  {/if}

  <div class="workspace">
    {#if chatPanelVisible}
      <div class="workspace-left">
        <div class="refs-section" class:expanded={refsExpanded}>
          <button class="refs-toggle" onclick={() => refsExpanded = !refsExpanded}>
            <Icon size={12}>
              <path d="m9 18 6-6-6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
            </Icon>
            <span>References</span>
            {#if refCount > 0}
              <span class="ref-count">{refCount}</span>
            {/if}
          </button>
          {#if refsExpanded}
            <div class="refs-content">
              <RefsPanel {projectPath} compact={true} onCountUpdate={handleRefCountUpdate}
                onViewRef={async (ref) => {
                  refViewerFilename = ref.filename;
                  refViewerContent = '';
                  refViewerOpen = true;
                  try {
                    const result = await window.api.refs.read(projectPath, ref.filename);
                    refViewerContent = result.content;
                  } catch {
                    refViewerContent = 'Error loading document.';
                  }
                }}
              />
            </div>
          {/if}
        </div>

        <div class="chat-area">
          {#key chatReloadKey}
            <ChatPanel
              {projectPath}
              refCount={refCount}
              onOpenRefs={() => { refsExpanded = true; }}
              onOpenOutline={() => { outlineOpen = true; }}
              onSnapshotRestored={handleSnapshotRestored}
            />
          {/key}
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

      {#if refViewerOpen}
        <div class="history-overlay ref-viewer-overlay">
          <div class="ref-viewer-panel">
            <div class="ref-viewer-header">
              <h3>{refViewerFilename}</h3>
              <button class="btn-ghost btn-sm" onclick={() => refViewerOpen = false} title="Close">
                <Icon size={16}><path d="M18 6 6 18"/><path d="m6 6 12 12"/></Icon>
              </button>
            </div>
            <div class="ref-viewer-body">
              {#if refViewerContent}
                {@html marked(refViewerContent)}
              {:else}
                <span class="text-tertiary">Loading…</span>
              {/if}
            </div>
          </div>
        </div>
      {/if}

      {#if outlineOpen}
        <div class="history-overlay">
          <OutlinePanel {projectPath} onClose={() => outlineOpen = false} />
        </div>
      {/if}

    </div>
  </div>
</div>

{#if staleBindingPrompt}
  <ConfirmDialog
    title="Linked Cloud Course Missing"
    message={staleBindingPrompt.message || `"${project?.title || project?.name || 'This project'}" is still linked to a CourseCode Cloud course that no longer exists.`}
    detail={project?.githubLinked
      ? 'You can clear the old local cloud link and update the preview deployment now, or clear the link only and leave this project in a not deployed state. Production deploys stay managed by GitHub.'
      : 'You can clear the old local cloud link and redeploy now, or clear the link only and leave this project in a not deployed state.'}
    alternateLabel="Clear Link Only"
    confirmLabel={project?.githubLinked ? 'Clear Link and Deploy Preview' : 'Clear Link and Redeploy'}
    cancelLabel="Not Now"
    onconfirm={confirmRepairDeploy}
    onalternate={clearStaleBindingOnly}
    oncancel={dismissStaleBindingPrompt}
  />
{/if}

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

  .toolbar-status-badge {
    display: inline-flex;
    align-items: center;
    height: 28px;
    padding: 0 10px;
    border-radius: var(--radius-pill);
    background: var(--bg-secondary);
    color: var(--text-secondary);
    font-size: var(--text-xs);
    font-weight: 600;
    white-space: nowrap;
  }

  .toolbar-status-badge.active {
    background: color-mix(in srgb, var(--success) 16%, transparent);
    color: var(--success);
  }

  .toolbar-status-badge.disabled,
  .toolbar-status-badge.missing {
    background: color-mix(in srgb, var(--warning) 12%, transparent);
    color: var(--warning);
  }

  .toolbar-status-badge.expired {
    background: color-mix(in srgb, var(--danger) 14%, transparent);
    color: var(--danger);
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
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
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

  /* ── Ref Viewer Overlay ── */
  .ref-viewer-overlay {
    left: 0;
  }

  .ref-viewer-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg-primary);
    width: 100%;
  }

  .ref-viewer-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    background: var(--bg-elevated);
  }

  .ref-viewer-header h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }

  .ref-viewer-body {
    flex: 1;
    overflow-y: auto;
    padding: 16px 24px;
    font-size: var(--text-sm);
    line-height: 1.7;
    color: var(--text-secondary);
  }

  .ref-viewer-body :global(h1),
  .ref-viewer-body :global(h2),
  .ref-viewer-body :global(h3) {
    color: var(--text-primary);
    margin: 1.2em 0 0.4em;
    line-height: 1.3;
  }

  .ref-viewer-body :global(h1) { font-size: var(--text-lg); }
  .ref-viewer-body :global(h2) { font-size: var(--text-md); }
  .ref-viewer-body :global(h3) { font-size: var(--text-sm); font-weight: 600; }

  .ref-viewer-body :global(p) { margin: 0 0 0.8em; }

  .ref-viewer-body :global(ul),
  .ref-viewer-body :global(ol) {
    margin: 0 0 0.8em;
    padding-left: 1.5em;
  }

  .ref-viewer-body :global(pre) {
    margin: 0 0 0.8em;
    padding: 12px;
    background: var(--bg-secondary);
    border-radius: var(--radius-sm);
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: var(--text-xs);
  }

  .ref-viewer-body :global(code) {
    font-size: var(--text-xs);
    background: var(--bg-secondary);
    padding: 1px 4px;
    border-radius: var(--radius-sm);
  }

  .ref-viewer-body :global(pre code) {
    background: none;
    padding: 0;
  }

  .ref-viewer-body :global(table) {
    width: 100%;
    border-collapse: collapse;
    margin: 0 0 0.8em;
    font-size: var(--text-xs);
  }

  .ref-viewer-body :global(th),
  .ref-viewer-body :global(td) {
    border: 1px solid var(--border);
    padding: 6px 10px;
    text-align: left;
  }

  .ref-viewer-body :global(th) {
    background: var(--bg-secondary);
    font-weight: 600;
  }

  .ref-viewer-body :global(blockquote) {
    margin: 0 0 0.8em;
    padding: 6px 12px;
    border-left: 3px solid var(--border);
    color: var(--text-tertiary);
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
  /* ── Export Popover ── */
  .export-wrapper {
    position: relative;
  }

  .export-popover {
    position: fixed;
    z-index: 1000;
    width: 260px;
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

  .export-format-select {
    width: 100%;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: var(--text-sm);
    outline: none;
    cursor: pointer;
    transition: border-color var(--duration-fast) var(--ease);
  }

  .export-format-select:focus {
    border-color: var(--accent);
  }

  /* ── Deploy Popover ── */
  .deploy-wrapper {
    position: relative;
  }

  .deploy-popover {
    width: min(360px, calc(100vw - 32px));
    max-height: calc(100vh - 48px);
    overflow: auto;
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

  .deploy-dialog-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgba(9, 14, 24, 0.48);
    backdrop-filter: blur(4px);
    animation: fadeIn 120ms var(--ease);
  }

  .deploy-dialog-panel {
    position: relative;
  }

  .deploy-popover-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
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

  .preview-link-panel {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    border-radius: var(--radius-sm);
    background: var(--bg-secondary);
    border: 1px solid var(--border);
  }

  .preview-link-panel.compact {
    margin-top: 2px;
  }

  .preview-link-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .preview-link-title {
    font-size: var(--text-xs);
    font-weight: 700;
    color: var(--text-secondary);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .preview-link-state {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 700;
    background: color-mix(in srgb, var(--bg-elevated) 78%, transparent);
    color: var(--text-secondary);
  }

  .preview-link-state.active {
    background: color-mix(in srgb, var(--success) 16%, transparent);
    color: var(--success);
  }

  .preview-link-state.disabled,
  .preview-link-state.missing {
    background: color-mix(in srgb, var(--warning) 12%, transparent);
    color: var(--warning);
  }

  .preview-link-state.expired {
    background: color-mix(in srgb, var(--danger) 14%, transparent);
    color: var(--danger);
  }

  .preview-link-copy {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    line-height: 1.45;
  }

  .preview-link-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .preview-link-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 28px;
    padding: 0 10px;
    border-radius: var(--radius-sm);
    border: 1px solid color-mix(in srgb, var(--accent) 18%, transparent);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    color: var(--accent);
    font-size: var(--text-xs);
    font-weight: 600;
    cursor: pointer;
    transition: all var(--duration-fast) var(--ease);
  }

  .preview-link-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 18%, transparent);
  }

  .preview-link-btn.subtle {
    border-color: var(--border);
    background: transparent;
    color: var(--text-secondary);
  }

  .preview-link-btn.subtle:hover:not(:disabled) {
    background: var(--bg-elevated);
  }

  .preview-link-btn:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .deploy-popover-input::placeholder {
    color: var(--text-tertiary);
  }

  .deploy-toggle-row {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    background: var(--bg-secondary);
    border: 1px solid var(--border);
  }

  .deploy-toggle-label {
    display: flex;
    align-items: center;
    gap: var(--sp-xs);
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text-primary);
    cursor: pointer;
    user-select: none;
  }

  .deploy-toggle-label input[type="checkbox"] {
    accent-color: var(--accent);
    width: 14px;
    height: 14px;
    cursor: pointer;
    flex-shrink: 0;
  }

  .deploy-toggle-tip {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    padding-left: 22px;
    line-height: 1.4;
  }

  .deploy-popover-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 2px;
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
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
