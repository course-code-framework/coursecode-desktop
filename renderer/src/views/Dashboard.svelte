<script>
  import { onMount, onDestroy } from 'svelte';
  import { projects, loading, refreshProjects, updateProject } from '../stores/projects.js';
  import { user, loadCloudUser } from '../stores/auth.js';
  import { settings } from '../stores/settings.js';
  import { tabs } from '../stores/tabs.js';
  import EmptyState from '../components/EmptyState.svelte';
  import ConfirmDialog from '../components/ConfirmDialog.svelte';
  import Icon from '../components/Icon.svelte';
  import DeployProgressDialog from '../components/DeployProgressDialog.svelte';
  import VersionModal from '../components/VersionModal.svelte';
  import { showToast } from '../stores/toast.js';
  import { popover } from '../actions/popover.js';
  import { getDisplayErrorMessage } from '../lib/errors.js';

  let { onCreateNew, onOpenProject, onCloseProject, onOpenSettings } = $props();

  let previewStatuses = $state({});
  let cloudStatuses = $state({});
  let searchQuery = $state('');
  let formatFilter = $state('all');
  let sortBy = $state('modified'); // 'modified' | 'name' | 'format' | 'created'
  let pinnedPaths = $state(new Set());
  let actionInProgress = $state({});
  let deployPopover = $state(null);
  let deployPopoverEl = $state(null);
  let deployAnchorEl = $state(null);
  let deployPopoverStyle = $state('');
  let deployReason = $state('');
  let deployPromote = $state(false);
  let deployPreview = $state(false);
  let exportPopover = $state(null);
  let exportFormat = $state('');
  let deleteDialog = $state(null); // { project, deleteFromCloud: bool }
  let staleBindingPrompt = $state(null); // { project, message }
  let statusInterval = null;
  let cloudStatusInterval = null;
  let refreshingCloudStatuses = $state(false);
  let deployProgress = $state({});
  let unsubDeployProgress = null;
  let versionModal = $state(null); // { project } when open

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

  function hasUpgrade(project) {
    return project?.frameworkVersion && $settings.cliVersion && compareSemver($settings.cliVersion, project.frameworkVersion) > 0;
  }

  function openVersionModal(e, project) {
    e.stopPropagation();
    versionModal = { project };
  }

  function handleVersionUpgraded(project, newVersion) {
    // Refresh the project list so the card shows the new version
    refreshProjects();
  }

  const formatLabels = {
    'cmi5': 'cmi5',
    'scorm2004': 'SCORM 2004',
    'scorm1.2': 'SCORM 1.2',
    'lti': 'LTI'
  };

  const formatOptions = [
    { value: 'all', label: 'All Formats' },
    { value: 'cmi5', label: 'cmi5' },
    { value: 'scorm2004', label: 'SCORM 2004' },
    { value: 'scorm1.2', label: 'SCORM 1.2' },
    { value: 'lti', label: 'LTI' }
  ];

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff/60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff/3600000)}h ago`;
    if (diff < 172800000) return 'Yesterday';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function truncatePath(path) {
    const parts = path.split('/');
    if (parts.length <= 4) return path;
    return '~/' + parts.slice(-3).join('/');
  }

  $effect(() => {
    const filtered = $projects.filter(p => {
      if (searchQuery && !p.title?.toLowerCase().includes(searchQuery.toLowerCase()) && !p.name?.toLowerCase().includes(searchQuery.toLowerCase())) return false;
      if (formatFilter !== 'all' && p.format !== formatFilter) return false;
      return true;
    });

    // Sort
    filtered.sort((a, b) => {
      // Pinned always first
      const aPinned = pinnedPaths.has(a.path);
      const bPinned = pinnedPaths.has(b.path);
      if (aPinned !== bPinned) return aPinned ? -1 : 1;

      switch (sortBy) {
        case 'name':
          return (a.title || a.name || '').localeCompare(b.title || b.name || '');
        case 'format':
          return (a.format || '').localeCompare(b.format || '');
        case 'created':
          return new Date(b.created || 0) - new Date(a.created || 0);
        case 'modified':
        default:
          return new Date(b.lastModified || 0) - new Date(a.lastModified || 0);
      }
    });

    filteredProjects = filtered;
  });

  let filteredProjects = $state([]);

  async function refreshStatuses() {
    try {
      previewStatuses = await window.api.preview.statusAll();
    } catch { /* ignore */ }
  }

  async function refreshCloudStatuses() {
    if (refreshingCloudStatuses || !$user) {
      if (!$user) cloudStatuses = {};
      return;
    }

    const linkedProjects = $projects.filter((project) => project.cloudId);
    if (!linkedProjects.length) {
      cloudStatuses = {};
      return;
    }

    refreshingCloudStatuses = true;
    try {
      const entries = await Promise.all(
        linkedProjects.map(async (project) => {
          try {
            const status = await window.api.cloud.getDeployStatus(project.path);
            return [project.path, status];
          } catch {
            return [project.path, null];
          }
        })
      );

      const next = {};
      for (const [path, status] of entries) {
        if (status) next[path] = status;
        if (status?.errorCode === 'stale_cloud_binding' && !staleBindingPrompt) {
          const project = linkedProjects.find((candidate) => candidate.path === path);
          if (project) {
            staleBindingPrompt = {
              project,
              message: `"${project.title || project.name}" is still linked to a CourseCode Cloud course that no longer exists.`
            };
          }
        }
        // Detect GitHub-linked courses from the status response
        const isGithub = status?.source?.type === 'github' || status?.source_type === 'github';
        const project = linkedProjects.find((candidate) => candidate.path === path);
        if (project && project.githubLinked !== isGithub) {
          updateProject(path, { githubLinked: isGithub || undefined });
        }
      }
      cloudStatuses = next;
    } finally {
      refreshingCloudStatuses = false;
    }
  }

  onMount(() => {
    refreshProjects();
    loadCloudUser();
    refreshStatuses();
    refreshCloudStatuses();
    unsubDeployProgress = window.api.cloud.onDeployProgress(handleDeployProgress);
    statusInterval = setInterval(refreshStatuses, 3000);
    cloudStatusInterval = setInterval(refreshCloudStatuses, 60000);

    // Load pinned projects from localStorage
    try {
      const saved = localStorage.getItem('coursecode-pinned-projects');
      if (saved) pinnedPaths = new Set(JSON.parse(saved));
    } catch { /* ignore */ }

    document.addEventListener('mousedown', handleDeployOutsideClick);
    window.addEventListener('resize', updateDeployPopoverPosition);
    window.addEventListener('scroll', updateDeployPopoverPosition, true);
  });

  onDestroy(() => {
    if (statusInterval) clearInterval(statusInterval);
    if (cloudStatusInterval) clearInterval(cloudStatusInterval);
    unsubDeployProgress?.();
    document.removeEventListener('mousedown', handleDeployOutsideClick);
    window.removeEventListener('resize', updateDeployPopoverPosition);
    window.removeEventListener('scroll', updateDeployPopoverPosition, true);
  });

  $effect(() => {
    if (deployPopover && deployPopoverEl) {
      requestAnimationFrame(updateDeployPopoverPosition);
      requestAnimationFrame(updateDeployPopoverPosition);
    }
  });

  $effect(() => {
    if (!$user) {
      cloudStatuses = {};
      return;
    }
    if ($projects.some((project) => project.cloudId)) refreshCloudStatuses();
  });

  function getStatus(path) {
    return previewStatuses[path]?.status || 'stopped';
  }

  function getPort(path) {
    return previewStatuses[path]?.port || null;
  }

  function isTabOpen(path) {
    return $tabs.some(t => t.id === path);
  }

  async function togglePreview(e, project) {
    e.stopPropagation();
    const path = project.path;
    try {
      if ($settings.keepPreviewRunningWithoutTab) {
        const currentStatus = getStatus(path);
        if (currentStatus === 'running') {
          await window.api.preview.stop(path);
          if (isTabOpen(path)) onCloseProject?.(path);
        } else {
          await window.api.preview.start(path, { openBrowser: false });
        }
      } else if (isTabOpen(path)) {
        onCloseProject?.(path);
      } else {
        onOpenProject?.(path, project.title);
      }
    } catch (err) {
      showToast({ type: 'error', message: `Preview toggle failed: ${err.message}` });
    } finally {
      setTimeout(refreshStatuses, 300);
    }
  }

  function openExportPopover(e, project) {
    e.stopPropagation();
    if (actionInProgress[project.path]) return;
    if (exportPopover === project.path) {
      exportPopover = null;
    } else {
      exportPopover = project.path;
      exportFormat = project.format || 'cmi5';
    }
  }

  async function exportBuild(e, project) {
    e.stopPropagation();
    exportPopover = null;
    const format = exportFormat || project.format || 'cmi5';
    const courseName = (project.title || 'course').replace(/[<>:"/\\|?*]/g, '-').replace(/\s+/g, '_').toLowerCase();
    const defaultName = `${courseName}_${format}.zip`;

    const savePath = await window.api.dialog.saveFile(defaultName);
    if (!savePath) return;

    actionInProgress = { ...actionInProgress, [project.path]: 'building' };
    try {
      const result = await window.api.build.export(project.path, format, savePath);
      const filename = savePath.split('/').pop() || savePath.split('\\').pop();
      showToast({
        type: 'success',
        message: `Exported — ${filename} (${(result.size / 1024).toFixed(0)} KB)`,
        action: { label: 'Open Folder', handler: () => window.api.tools.openInFinder(result.savedPath || result.zipPath) }
      });
    } catch (err) {
      showToast({ type: 'error', message: `Export failed: ${err.message}` });
    }
    delete actionInProgress[project.path];
    actionInProgress = { ...actionInProgress };
  }

  function resetDeployOptions(project = null) {
    deployReason = '';
    deployPromote = false;
    deployPreview = project ? getCloudPreviewState(project.path) === 'active' : false;
  }

  function getCloudStatus(path) {
    return cloudStatuses[path] || null;
  }

  function getCloudPreviewState(path) {
    return getCloudStatus(path)?.previewLink?.state || null;
  }

  function hasActiveCloudPreview(path) {
    return getCloudPreviewState(path) === 'active';
  }

  function canUpdatePreviewPointer(path) {
    return getCloudPreviewState(path) === 'active';
  }

  function isPreviewLinkBusy(path) {
    return actionInProgress[path] === 'preview-link';
  }

  function getDeployProgress(path) {
    return deployProgress[path] || null;
  }

  function setDeployProgress(path, nextValue) {
    deployProgress = { ...deployProgress, [path]: nextValue };
  }

  function clearDeployProgress(path) {
    if (!deployProgress[path]) return;
    const next = { ...deployProgress };
    delete next[path];
    deployProgress = next;
  }

  function getDeployTargetLabel(project, repairBinding = false, overrides = {}) {
    const preview = Object.prototype.hasOwnProperty.call(overrides, 'preview') ? overrides.preview : deployPreview;
    const promote = Object.prototype.hasOwnProperty.call(overrides, 'promote') ? overrides.promote : deployPromote;
    if (repairBinding && preview) return 'Repairing link and updating preview';
    if (preview) return 'Updating cloud preview';
    if (repairBinding) return 'Repairing cloud link';
    if (promote) return 'Deploying to production';
    if (project.githubLinked) return 'Updating cloud preview';
    return 'Deploying to CourseCode Cloud';
  }

  function hasExistingCloudDeployment(project) {
    return !!project?.cloudId;
  }

  function canShowProductionUpdate(project) {
    return hasExistingCloudDeployment(project) && !project?.githubLinked;
  }

  function getPreviewToggleLabel(project) {
    return hasExistingCloudDeployment(project) ? 'Preview Link On' : 'Also Turn On Preview';
  }

  function getPreviewToggleCopy(project) {
    const currentState = getCloudPreviewState(project.path);
    if (!hasExistingCloudDeployment(project)) {
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

  function getPreviewPanelCopy(project) {
    const previewState = getCloudPreviewState(project.path);
    if (previewState === 'active') {
      return hasExistingCloudDeployment(project)
        ? 'The preview URL is live and can stay synced to the latest deployed version.'
        : 'The preview URL is live. You can publish this first deploy there too.';
    }
    if (previewState === 'expired') {
      return hasExistingCloudDeployment(project)
        ? 'The preview URL expired. Turn it back on if you want preview to resume tracking new deploys.'
        : 'The preview URL expired. Turn it back on before publishing this first deploy there.';
    }
    if (previewState === 'disabled') {
      return hasExistingCloudDeployment(project)
        ? 'The preview URL is off. Turn it on if you want preview to track this deploy.'
        : 'The preview URL is off. Turn it on to publish a preview URL with this deploy.';
    }
    return hasExistingCloudDeployment(project)
      ? 'No preview URL exists yet. Turn it on to create one.'
      : 'No preview URL exists yet. Turn it on to create one for this deploy.';
  }

  function getPreviewActionButtonLabel(project) {
    if (!hasExistingCloudDeployment(project)) return null;
    return getCloudPreviewState(project.path) === 'active' ? 'Open Link' : null;
  }

  function beginDeployProgress(project, repairBinding = false, overrides = {}) {
    clearDeployProgress(project.path);
    setDeployProgress(project.path, {
      active: true,
      stage: 'building',
      message: 'Preparing deployment...',
      targetLabel: getDeployTargetLabel(project, repairBinding, overrides),
      dashboardUrl: '',
      previewUrl: ''
    });
  }

  function handleDeployProgress(data) {
    if (!data?.projectPath) return;
    const path = data.projectPath;
    const current = getDeployProgress(path) || {};
    setDeployProgress(path, {
      ...current,
      active: current.active ?? true,
      stage: data.stage || current.stage || 'building',
      message: data.message || current.message || 'Preparing deployment...'
    });
  }

  function getCloudPreviewLabel(path) {
    const state = getCloudPreviewState(path);
    if (!state) return null;
    if (state === 'active') return 'Preview Live';
    if (state === 'disabled') return 'Preview Off';
    if (state === 'expired') return 'Preview Expired';
    if (state === 'missing') return 'No Preview';
    return 'Preview';
  }

  function openCloudPreview(e, project) {
    e.stopPropagation();
    const url = getCloudStatus(project.path)?.previewLink?.url;
    if (url) window.open(url);
  }

  async function setPreviewLinkState(e, project, enabled, { autoSelectPreview = false } = {}) {
    e?.stopPropagation?.();
    actionInProgress = { ...actionInProgress, [project.path]: 'preview-link' };
    try {
      const previewLink = getCloudStatus(project.path)?.previewLink;
      const options = enabled ? { enable: true } : { disable: true };
      if (enabled && (!previewLink?.exists || previewLink?.state === 'expired')) {
        options.expiresInDays = 7;
      }

      await window.api.cloud.updatePreviewLink(project.path, options);
      await refreshCloudStatuses();

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
      delete actionInProgress[project.path];
      actionInProgress = { ...actionInProgress };
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

  function openDeployPopover(e, project) {
    e.stopPropagation();
    if (!$user) {
      showToast({ type: 'warning', message: 'Sign in to CourseCode Cloud to deploy. Go to Settings → Cloud Account.' });
      return;
    }
    if (deployPopover === project.path) {
      deployPopover = null;
      deployAnchorEl = null;
    } else {
      deployAnchorEl = e.currentTarget;
      deployPopover = project.path;
      resetDeployOptions(project);
    }
  }

  function getDeployPopoverProject() {
    return $projects.find((project) => project.path === deployPopover) || null;
  }

  function updateDeployPopoverPosition() {
    if (!deployAnchorEl || !deployPopoverEl || !deployPopover) return;

    const rect = deployAnchorEl.getBoundingClientRect();
    const popW = deployPopoverEl.offsetWidth;
    const popH = deployPopoverEl.offsetHeight;
    const gap = 8;
    const margin = 8;

    let left = rect.right - popW;
    left = Math.max(margin, Math.min(left, window.innerWidth - popW - margin));

    const belowTop = rect.bottom + gap;
    const aboveTop = rect.top - popH - gap;
    let top = belowTop;
    if (belowTop + popH > window.innerHeight - margin && aboveTop >= margin) {
      top = aboveTop;
    }
    top = Math.max(margin, Math.min(top, window.innerHeight - popH - margin));

    deployPopoverStyle = `top:${top}px;left:${left}px;`;
  }

  function handleDeployOutsideClick(e) {
    if (!deployPopover) return;
    if (deployAnchorEl?.contains(e.target)) return;
    if (deployPopoverEl?.contains(e.target)) return;
    deployPopover = null;
    deployAnchorEl = null;
  }

  async function confirmDeploy(e, project, repairBinding = false, overrides = {}) {
    e?.stopPropagation?.();
    deployPopover = null;
    deployAnchorEl = null;
    beginDeployProgress(project, repairBinding, overrides);
    actionInProgress = { ...actionInProgress, [project.path]: 'deploying' };
    const desiredPreviewEnabled = Object.prototype.hasOwnProperty.call(overrides, 'preview') ? !!overrides.preview : deployPreview;
    const initialPreviewState = getCloudPreviewState(project.path);
    let enabledPreviewForAttempt = false;
    try {
      if (desiredPreviewEnabled && initialPreviewState !== 'active' && hasExistingCloudDeployment(project)) {
        setDeployProgress(project.path, {
          ...(getDeployProgress(project.path) || {}),
          message: 'Turning on preview link...'
        });
        const previewLink = getCloudStatus(project.path)?.previewLink;
        const enableOptions = { enable: true };
        if (!previewLink?.exists || previewLink?.state === 'expired') enableOptions.expiresInDays = 7;
        await window.api.cloud.updatePreviewLink(project.path, enableOptions);
        enabledPreviewForAttempt = true;
        await refreshCloudStatuses();
      }

      const result = await window.api.cloud.deploy(project.path, getDeployOptions(repairBinding, overrides));
      // Refresh so cloud icon appears immediately after first deploy
      await refreshProjects();
      await refreshCloudStatuses();
      if (!desiredPreviewEnabled && initialPreviewState === 'active' && hasExistingCloudDeployment(project)) {
        setDeployProgress(project.path, {
          ...(getDeployProgress(project.path) || {}),
          message: 'Turning off preview link...'
        });
        await window.api.cloud.updatePreviewLink(project.path, { disable: true });
        await refreshCloudStatuses();
      }
      const previewUrl = desiredPreviewEnabled
        ? (result?.previewUrl || getCloudStatus(project.path)?.previewLink?.url || null)
        : null;
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
      setDeployProgress(project.path, {
        ...(getDeployProgress(project.path) || {}),
        active: false,
        stage: 'complete',
        message: previewUrl ? 'Deployment finished. You can open the preview or cloud dashboard below.' : 'Deployment finished. You can review it in CourseCode Cloud.',
        dashboardUrl: result?.dashboardUrl || '',
        previewUrl: previewUrl || ''
      });
      resetDeployOptions();
    } catch (err) {
      if (enabledPreviewForAttempt) {
        try {
          await window.api.cloud.updatePreviewLink(project.path, { disable: true });
          await refreshCloudStatuses();
        } catch {
          // Best effort rollback of preview state when deploy never completed.
        }
      }
      setDeployProgress(project.path, {
        ...(getDeployProgress(project.path) || {}),
        active: false,
        stage: 'error',
        message: err?.code === 'STALE_CLOUD_BINDING'
          ? 'This project still points to a deleted CourseCode Cloud course.'
          : `Deploy failed: ${err.message}`,
        dashboardUrl: '',
        previewUrl: ''
      });
      if (err?.code === 'STALE_CLOUD_BINDING') {
        staleBindingPrompt = {
          project,
          message: err.message
        };
        return;
      }
      showToast({ type: 'error', message: `Deploy failed: ${getDisplayErrorMessage(err)}` });
      resetDeployOptions();
    } finally {
      delete actionInProgress[project.path];
      actionInProgress = { ...actionInProgress };
    }
  }

  function dismissStaleBindingPrompt() {
    staleBindingPrompt = null;
    resetDeployOptions();
  }

  async function confirmRepairDeploy() {
    if (!staleBindingPrompt) return;
    const { project } = staleBindingPrompt;
    staleBindingPrompt = null;
    await confirmDeploy(
      null,
      project,
      true,
      project.githubLinked ? { preview: true, promote: false } : { preview: getCloudPreviewState(project.path) === 'active' }
    );
  }

  async function clearStaleBindingOnly() {
    if (!staleBindingPrompt) return;
    const { project } = staleBindingPrompt;
    staleBindingPrompt = null;
    actionInProgress = { ...actionInProgress, [project.path]: 'deploying' };
    try {
      await window.api.projects.clearCloudBinding(project.path);
      await refreshProjects();
      await refreshCloudStatuses();
      showToast({
        type: 'success',
        message: 'Cloud link cleared. This course is no longer deployed.'
      });
    } catch (err) {
      showToast({ type: 'error', message: `Clear link failed: ${err.message}` });
    } finally {
      resetDeployOptions();
      delete actionInProgress[project.path];
      actionInProgress = { ...actionInProgress };
    }
  }

  function handleDeployPopoverKeydown(e, project) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      deployPopover = null;
      deployAnchorEl = null;
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // Only confirm if this isn't a GitHub-linked course (those block non-preview deploys)
      if (!project.githubLinked) confirmDeploy(e, project);
    }
  }

  function openInFinder(e, path) {
    e.stopPropagation();
    window.api.tools.openCourseFolder(path);
  }

  function openTerminal(e, path) {
    e.stopPropagation();
    window.api.tools.openTerminal(path);
  }

  function openDeleteDialog(e, project) {
    e.stopPropagation();
    if (actionInProgress[project.path]) return;
    deleteDialog = { project, deleteFromCloud: false };
  }

  function closeDeleteDialog() {
    deleteDialog = null;
  }

  async function confirmDeleteDialog() {
    if (!deleteDialog) return;
    const { project, deleteFromCloud } = deleteDialog;
    const path = project.path;
    closeDeleteDialog();

    actionInProgress = { ...actionInProgress, [path]: 'deleting' };
    try {
      if (isTabOpen(path)) await onCloseProject?.(path);
      await window.api.projects.delete(path, { deleteFromCloud });
      await refreshProjects();
      await refreshStatuses();
      showToast({ type: 'success', message: `"${project.title || project.name}" moved to Trash.`, duration: 3000 });
    } catch (err) {
      showToast({ type: 'error', message: `Delete failed: ${err.message}` });
    } finally {
      delete actionInProgress[path];
      actionInProgress = { ...actionInProgress };
    }
  }

  function togglePin(e, project) {
    e.stopPropagation();
    const next = new Set(pinnedPaths);
    if (next.has(project.path)) {
      next.delete(project.path);
    } else {
      next.add(project.path);
    }
    pinnedPaths = next;
    localStorage.setItem('coursecode-pinned-projects', JSON.stringify([...next]));
  }
</script>

<div class="dashboard" data-testid="dashboard">
  <header class="header">
    <div class="header-left">
      <svg class="app-logo" width="24" height="24" viewBox="0 18 100 64" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="25,22 5,50 25,78" />
        <polyline points="75,22 95,50 75,78" />
        <path d="M50,28 C40,28 33,36 33,45 C33,52 38,56 42,60 L42,65 L58,65 L58,60 C62,56 67,52 67,45 C67,36 60,28 50,28" stroke-width="4" />
        <line x1="44" y1="70" x2="56" y2="70" stroke-width="4" />
        <line x1="46" y1="75" x2="54" y2="75" stroke-width="4" />
      </svg>
      <h1 class="app-title">CourseCode</h1>
    </div>
    <div class="header-center">
      <div class="search-bar">
        <svg class="search-icon" width="14" height="14" viewBox="0 0 16 16" fill="none">
          <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" stroke-width="1.5"/>
          <path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        <input
          type="text"
          class="search-input"
          placeholder="Search courses…"
          bind:value={searchQuery}
        />
        <select class="format-select" bind:value={formatFilter}>
          {#each formatOptions as opt}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
        <select class="sort-select" bind:value={sortBy}>
          <option value="modified">Last Modified</option>
          <option value="name">Name A–Z</option>
          <option value="format">Format</option>
          <option value="created">Date Created</option>
        </select>
      </div>
    </div>
    <div class="header-right">
      <button class="btn-primary" onclick={onCreateNew} data-testid="new-course-btn">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
        New Course
      </button>
      {#if $user}
        <button class="btn-ghost avatar-btn" onclick={onOpenSettings} title={$user.email}>
          <div class="avatar"><span class="avatar-initial">{$user.email?.[0]?.toUpperCase() || 'U'}</span></div>
        </button>
      {:else}
        <button class="btn-ghost" onclick={onOpenSettings}>Sign In</button>
      {/if}
    </div>
  </header>

  <main class="content">
    {#if $loading}
      <div class="course-grid">
        {#each [1,2,3] as _}
          <div class="skeleton-card"></div>
        {/each}
      </div>
    {:else if $projects.length === 0}
      <EmptyState
        title="Create Your First Course"
        description="Build interactive, deployable courses with or without AI. No coding experience required."
        actionLabel="New Course"
        onAction={onCreateNew}
      />
    {:else if filteredProjects.length === 0}
      <div class="no-results">
        <p class="text-secondary">No courses match your search.</p>
      </div>
    {:else}
      <div class="course-grid" data-testid="course-list">
        {#each filteredProjects as project (project.path)}
          {@const status = getStatus(project.path)}
          {@const port = getPort(project.path)}
          {@const tabOpen = isTabOpen(project.path)}
          {@const running = status === 'running'}
          {@const inProgress = actionInProgress[project.path]}
          {@const cloudStatus = getCloudStatus(project.path)}
          {@const cloudPreviewLabel = getCloudPreviewLabel(project.path)}
          {@const cloudPreviewState = getCloudPreviewState(project.path)}

          <div class="course-card" class:active={tabOpen} class:has-popover={deployPopover === project.path || exportPopover === project.path}>
            <button
              class="pin-btn pin-corner"
              class:pinned={pinnedPaths.has(project.path)}
              onclick={(e) => togglePin(e, project)}
              title={pinnedPaths.has(project.path) ? 'Unpin' : 'Pin to top'}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill={pinnedPaths.has(project.path) ? 'currentColor' : 'none'}>
                <path d="M8 1.5l1.76 3.57 3.94.57-2.85 2.78.67 3.93L8 10.52l-3.52 1.83.67-3.93L2.3 5.64l3.94-.57L8 1.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
              </svg>
            </button>
            <!-- Row 1: Title left, meta right -->
            <div class="card-header">
              <div class="card-title-row">
                <button class="card-title-btn" onclick={() => onOpenProject(project.path, project.title)}>
                  <h3 class="card-title">{project.title}</h3>
                </button>
              </div>
              <div class="card-badge-row">
                <span class="format-badge">{formatLabels[project.format] || project.format}</span>
                {#if project.githubLinked}
                  <span class="github-badge" title="Deployed via GitHub">
                    <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
                    </svg>
                    GitHub
                  </span>
                {/if}
                {#if project.cloudId && cloudPreviewLabel}
                  <span class="cloud-preview-badge" class:active={cloudPreviewState === 'active'} class:disabled={cloudPreviewState === 'disabled'} class:expired={cloudPreviewState === 'expired'} class:missing={cloudPreviewState === 'missing'} title={cloudStatus?.previewLink?.url || 'Cloud preview status'}>
                    {cloudPreviewLabel}
                  </span>
                {/if}
                {#if running}
                  <span class="status-pill">
                    <span class="status-pulse"></span>
                    Running{#if port}<span class="port-text">:{port}</span>{/if}
                  </span>
                {/if}
              </div>
              <div class="header-right-meta">
                <span class="meta-path" title={project.path}>{truncatePath(project.path)}</span>
                <span class="meta-dot">·</span>
                <span class="meta-date">{formatDate(project.lastModified)}</span>
                {#if project.frameworkVersion}
                  <span class="meta-dot">·</span>
                  <button class="meta-version-btn" onclick={(e) => openVersionModal(e, project)} title={hasUpgrade(project) ? `v${project.frameworkVersion} — Update available` : `v${project.frameworkVersion}`}>
                    <span class="meta-version">v{project.frameworkVersion}</span>
                    {#if hasUpgrade(project)}
                      <svg class="version-info-icon" width="12" height="12" viewBox="0 0 24 24" fill="none">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
                        <path d="M12 16v-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                        <circle cx="12" cy="9" r="1" fill="currentColor"/>
                      </svg>
                    {/if}
                  </button>
                {/if}
              </div>
            </div>

            <div class="card-detail-row">
              <span class="detail-item">
                <span class="detail-label">Status</span>
                <span class="detail-value" class:running={running}>{running ? 'Preview Running' : 'Ready to Preview'}</span>
              </span>
              {#if project.cloudId}
                <span class="detail-item">
                  <span class="detail-label">Cloud Preview</span>
                  <span class="detail-value" class:running={cloudPreviewState === 'active'}>{cloudPreviewLabel || 'Checking…'}</span>
                </span>
              {:else}
                <span class="detail-item">
                  <span class="detail-label">Output</span>
                  <span class="detail-value">{formatLabels[project.format] || project.format}</span>
                </span>
              {/if}
              <span class="detail-item">
                <span class="detail-label">Updated</span>
                <span class="detail-value">{formatDate(project.lastModified)}</span>
              </span>
            </div>

            <!-- Row 2: Actions -->
            <div class="card-actions">
              <div class="actions-left">
                <button
                  class="card-btn primary"
                  class:active={running}
                  onclick={(e) => togglePreview(e, project)}
                  disabled={!!inProgress}
                  title={running ? 'Stop preview' : $settings.keepPreviewRunningWithoutTab ? 'Start preview in background' : 'Open & preview'}
                >
                  {#if running}
                    <Icon size={14} fill="currentColor">
                      <rect x="4" y="4" width="16" height="16" rx="2"/>
                    </Icon>
                    Stop
                  {:else}
                    <Icon size={14} fill="currentColor">
                      <path d="M6 4l14 8-14 8V4z"/>
                    </Icon>
                    {$settings.keepPreviewRunningWithoutTab ? 'Start' : 'Preview'}
                  {/if}
                </button>

                <div class="export-btn-wrapper">
                  <button
                    class="card-btn primary export"
                    onclick={(e) => openExportPopover(e, project)}
                    disabled={!!inProgress}
                    title="Export"
                  >
                    {#if inProgress === 'building'}
                      <div class="btn-spinner"></div>
                    {:else}
                      <Icon size={14}>
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                        <polyline points="7 10 12 15 17 10"/>
                        <line x1="12" y1="15" x2="12" y2="3"/>
                      </Icon>
                    {/if}
                    Export
                  </button>

                  {#if exportPopover === project.path}
                    <div class="export-popover" role="dialog" aria-label="Export options" use:popover>
                      <div class="deploy-popover-field">
                        <label class="deploy-popover-label">Format</label>
                        <select class="export-format-select" bind:value={exportFormat} onclick={(e) => e.stopPropagation()}>
                          {#each Object.entries(formatLabels) as [value, label]}
                            <option {value}>{label}</option>
                          {/each}
                        </select>
                      </div>
                      <div class="deploy-popover-actions">
                        <button class="deploy-popover-cancel" onclick={(e) => { e.stopPropagation(); exportPopover = null; }}>Cancel</button>
                        <button class="deploy-popover-confirm" onclick={(e) => exportBuild(e, project)}>Export</button>
                      </div>
                    </div>
                  {/if}
                </div>

                <div class="deploy-btn-wrapper">
                  <button
                    class="card-btn primary deploy"
                    class:github-locked={project.githubLinked}
                    onclick={(e) => { e.stopPropagation(); openDeployPopover(e, project); }}
                    disabled={!!inProgress}
                    title={project.githubLinked ? 'Deployed via GitHub \u2014 push to your repo to deploy' : 'Deploy'}
                  >
                    {#if inProgress === 'deploying'}
                      <div class="btn-spinner"></div>
                    {:else if project.githubLinked}
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
                      </svg>
                    {:else}
                      <Icon size={14}>
                        <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/>
                        <path d="M12 12v9"/>
                        <path d="m16 16-4-4-4 4"/>
                      </Icon>
                    {/if}
                    Deploy
                  </button>

                </div>
              </div>

              <div class="actions-right">
                {#if hasActiveCloudPreview(project.path)}
                  <button class="card-btn subtle" onclick={(e) => openCloudPreview(e, project)} title="Open Cloud preview">
                    <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
                      <path d="M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4-6.5-4-6.5-4z" stroke="currentColor" stroke-width="1.3"/>
                      <circle cx="8" cy="8" r="2.2" stroke="currentColor" stroke-width="1.3"/>
                    </svg>
                  </button>
                {/if}
                <button class="card-btn subtle" onclick={(e) => openInFinder(e, project.path)} title="Reveal in Finder">
                  <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
                    <path d="M2 4a2 2 0 012-2h3l2 2h3a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V4z" stroke="currentColor" stroke-width="1.3"/>
                  </svg>
                </button>
                <button class="card-btn subtle" onclick={(e) => openTerminal(e, project.path)} title="Open Terminal">
                  <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
                    <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" stroke-width="1.3"/>
                    <path d="M4 9l2.5-2L4 5M8 10h3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                </button>
                {#if project.cloudId}
                  <a
                    class="card-btn subtle"
                    href="https://coursecodecloud.com/dashboard/courses/{project.cloudId}"
                    target="_blank"
                    rel="noopener noreferrer"
                    onclick={(e) => e.stopPropagation()}
                    title="Open in CourseCode Cloud"
                  >
                    <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
                      <path d="M6 3H3a1 1 0 00-1 1v9a1 1 0 001 1h9a1 1 0 001-1v-3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
                      <path d="M9 2h5v5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
                      <path d="M14 2L8 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
                    </svg>
                  </a>
                {/if}
                <button
                  class="card-btn subtle danger"
                  onclick={(e) => openDeleteDialog(e, project)}
                  disabled={!!inProgress}
                  title="Delete course"
                >
                  {#if inProgress === 'deleting'}
                    <div class="btn-spinner"></div>
                  {:else}
                    <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
                      <path d="M3.5 4.5h9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
                      <path d="M6 4.5V3a1 1 0 011-1h2a1 1 0 011 1v1.5" stroke="currentColor" stroke-width="1.3"/>
                      <path d="M5 6.5v6a1 1 0 001 1h4a1 1 0 001-1v-6" stroke="currentColor" stroke-width="1.3"/>
                    </svg>
                  {/if}
                </button>
              </div>
            </div>

          </div>
        {/each}
      </div>
    {/if}
  </main>

  <!-- Delete confirmation dialog -->
  {#if deleteDialog}
    {@const dp = deleteDialog.project}
    <div class="dialog-backdrop" onclick={closeDeleteDialog} role="presentation">
      <div class="dialog" onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Delete course">
        <h2 class="dialog-title">Delete "{dp.title || dp.name}"?</h2>
        <p class="dialog-body">The project folder will be moved to Trash. This cannot be undone.</p>
        {#if dp.cloudId}
          <div class="dialog-cloud-row">
            <label class="dialog-cloud-label">
              <input type="checkbox" bind:checked={deleteDialog.deleteFromCloud} />
              <span>Also remove from CourseCode Cloud</span>
            </label>
            {#if dp.githubLinked}
              <p class="dialog-cloud-note warning">⚠ This course is GitHub-linked. Removing it from Cloud disconnects the integration \u2014 your repository and its files are unaffected.</p>
            {:else}
              <p class="dialog-cloud-note">Removes the course record, deployments, and analytics from Cloud.</p>
            {/if}
          </div>
        {/if}
        <div class="dialog-actions">
          <button class="dialog-cancel" onclick={closeDeleteDialog}>Cancel</button>
          <button class="dialog-confirm danger" onclick={confirmDeleteDialog}>Move to Trash</button>
        </div>
      </div>
    </div>
  {/if}

  {#if staleBindingPrompt}
    <ConfirmDialog
      title="Linked Cloud Course Missing"
      message={staleBindingPrompt.message || `"${staleBindingPrompt.project?.title || staleBindingPrompt.project?.name || 'This project'}" is still linked to a CourseCode Cloud course that no longer exists.`}
      detail={staleBindingPrompt.project?.githubLinked
        ? 'You can clear the old local cloud link and update the preview deployment now, or clear the link only and leave this project in a not deployed state. Production deploys stay managed by GitHub.'
        : 'You can clear the old local cloud link and redeploy now, or clear the link only and leave this project in a not deployed state.'}
      alternateLabel="Clear Link Only"
      confirmLabel={staleBindingPrompt.project?.githubLinked ? 'Clear Link and Deploy Preview' : 'Clear Link and Redeploy'}
      cancelLabel="Not Now"
      onconfirm={confirmRepairDeploy}
      onalternate={clearStaleBindingOnly}
      oncancel={dismissStaleBindingPrompt}
    />
  {/if}

  {#if getDeployPopoverProject()}
    {@const project = getDeployPopoverProject()}
    {@const cloudPreviewState = getCloudPreviewState(project.path)}
    {@const cloudPreviewLabel = getCloudPreviewLabel(project.path)}
    <div
      bind:this={deployPopoverEl}
      class="deploy-popover anchored"
      role="dialog"
      aria-modal="false"
      aria-label={project.githubLinked ? 'GitHub deploy info' : 'Deploy options'}
      style={deployPopoverStyle}
    >
      {#if project.githubLinked}
        <div class="github-info-header">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
          </svg>
          <strong>GitHub-linked course</strong>
        </div>
        <p class="github-info-body">Production deploys are controlled by your GitHub repo. Push to deploy.</p>
        <div class="preview-link-panel">
          <div class="preview-link-header">
            <span class="preview-link-title">Preview Link</span>
            <span class="preview-link-state" class:active={cloudPreviewState === 'active'} class:disabled={cloudPreviewState === 'disabled'} class:expired={cloudPreviewState === 'expired'} class:missing={cloudPreviewState === 'missing'}>{cloudPreviewLabel || 'Checking…'}</span>
          </div>
          <p class="preview-link-copy">
            {#if cloudPreviewState === 'active'}
              Stakeholders can open the cloud preview now.
            {:else if cloudPreviewState === 'expired'}
              The preview link expired. Turn it back on before deploying a new preview pointer.
            {:else if cloudPreviewState === 'disabled'}
              The preview link is off. Turn it on to publish a preview URL.
            {:else}
              No preview link exists yet. Turn it on to create one.
            {/if}
          </p>
          <div class="preview-link-actions">
            <button
              class="preview-link-btn"
              disabled={isPreviewLinkBusy(project.path)}
              onclick={(e) => setPreviewLinkState(e, project, cloudPreviewState !== 'active', { autoSelectPreview: true })}
            >
              {#if isPreviewLinkBusy(project.path)}
                <div class="btn-spinner"></div>
              {:else if cloudPreviewState === 'active'}
                Turn Off Preview
              {:else}
                Turn On Preview
              {/if}
            </button>
            {#if hasActiveCloudPreview(project.path)}
              <button class="preview-link-btn subtle" onclick={(e) => openCloudPreview(e, project)}>Open Link</button>
            {/if}
          </div>
        </div>
        <p class="github-info-body">You can still deploy a <strong>preview link</strong> directly:</p>
        <div class="deploy-popover-actions">
          <button class="deploy-popover-cancel" onclick={() => { deployPopover = null; deployAnchorEl = null; }}>Dismiss</button>
          <button class="deploy-popover-confirm" disabled={!canUpdatePreviewPointer(project.path) || isPreviewLinkBusy(project.path)} onclick={(e) => { deployPreview = true; confirmDeploy(e, project); }}>Deploy Preview</button>
        </div>
      {:else}
        <div class="deploy-popover-field">
          <label class="deploy-popover-label" for="deploy-reason-root">Reason <span class="optional-tag">optional</span></label>
          <input
            id="deploy-reason-root"
            type="text"
            class="deploy-popover-input"
            placeholder="e.g. Fixed quiz on slide 3"
            bind:value={deployReason}
            onkeydown={(e) => handleDeployPopoverKeydown(e, project)}
          />
        </div>
        {#if canShowProductionUpdate(project)}
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
            <span>{getPreviewToggleLabel(project)}</span>
          </label>
          <span class="deploy-toggle-tip">{getPreviewToggleCopy(project)}</span>
        </div>
        {#if hasExistingCloudDeployment(project)}
        <div class="preview-link-panel compact">
          <div class="preview-link-header">
            <span class="preview-link-title">Preview Link</span>
            <span class="preview-link-state" class:active={cloudPreviewState === 'active'} class:disabled={cloudPreviewState === 'disabled'} class:expired={cloudPreviewState === 'expired'} class:missing={cloudPreviewState === 'missing'}>{cloudPreviewLabel || 'Checking…'}</span>
          </div>
          <p class="preview-link-copy">{getPreviewPanelCopy(project)}</p>
          {#if getPreviewActionButtonLabel(project)}
            <div class="preview-link-actions">
              <button class="preview-link-btn subtle" onclick={(e) => openCloudPreview(e, project)}>Open Link</button>
            </div>
          {/if}
        </div>
        {/if}
        <div class="deploy-popover-actions">
          <button class="deploy-popover-cancel" onclick={() => { deployPopover = null; deployAnchorEl = null; }}>Cancel</button>
          <button class="deploy-popover-confirm" onclick={(e) => confirmDeploy(e, project)}>Deploy</button>
        </div>
      {/if}
    </div>
  {/if}

  {#each Object.entries(deployProgress) as [path, progress] (path)}
    <DeployProgressDialog
      active={progress.active ?? actionInProgress[path] === 'deploying'}
      stage={progress.stage || 'building'}
      message={progress.message || 'Preparing deployment...'}
      targetLabel={progress.targetLabel || 'Deploying to CourseCode Cloud'}
      dashboardUrl={progress.dashboardUrl || ''}
      previewUrl={progress.previewUrl || ''}
      onclose={() => clearDeployProgress(path)}
    />
  {/each}

  {#if versionModal}
    <VersionModal
      courseVersion={versionModal.project.frameworkVersion}
      installedVersion={$settings.cliVersion}
      courseName={versionModal.project.title || versionModal.project.name}
      projectPath={versionModal.project.path}
      onclose={() => versionModal = null}
      onupgraded={(v) => handleVersionUpgraded(versionModal.project, v)}
    />
  {/if}
</div>

<style>
  .dashboard {
    height: 100%;
    display: flex;
    flex-direction: column;
    background:
      radial-gradient(1200px 600px at 8% -20%, var(--accent-subtle), transparent 70%),
      var(--bg-primary);
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--sp-sm) var(--sp-xl);
    border-bottom: 1px solid var(--border);
    background: var(--bg-elevated);
    flex-shrink: 0;
    gap: var(--sp-lg);
    animation: dashboardFadeIn var(--duration-slow) var(--ease);
  }

  .header-left {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
  }

  .app-logo {
    color: var(--text-primary);
    flex-shrink: 0;
  }

  .app-title {
    font-size: var(--text-lg);
    font-weight: 700;
    color: var(--text-primary);
  }

  .header-center {
    flex: 1;
    max-width: 760px;
  }

  .search-bar {
    display: flex;
    align-items: center;
    gap: var(--sp-xs);
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0 var(--sp-sm);
    transition: border-color var(--duration-fast) var(--ease);
  }

  .search-bar:focus-within { border-color: var(--accent); }

  .search-icon {
    color: var(--text-tertiary);
    flex-shrink: 0;
  }

  .search-input {
    flex: 1;
    border: none;
    background: transparent;
    padding: 6px var(--sp-xs);
    font-size: var(--text-sm);
    outline: none;
    color: var(--text-primary);
    min-width: 100px;
  }

  .format-select,
  .sort-select {
    border: none;
    border-left: 1px solid var(--border);
    background: transparent;
    padding: 6px var(--sp-sm);
    font-size: var(--text-xs);
    color: var(--text-secondary);
    cursor: pointer;
    outline: none;
    width: auto;
  }

  .pin-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: var(--radius-sm);
    background: none;
    border: none;
    color: var(--text-tertiary);
    cursor: pointer;
    opacity: 0;
    transition: all var(--duration-fast) var(--ease);
    flex-shrink: 0;
  }

  .course-card:hover .pin-btn,
  .pin-btn.pinned {
    opacity: 1;
  }

  .pin-btn:hover {
    color: var(--accent);
    background: var(--accent-subtle);
  }

  .pin-btn.pinned {
    color: var(--accent);
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
    flex-shrink: 0;
  }

  .avatar-btn {
    width: 38px;
    height: 38px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .avatar {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background: var(--accent);
    color: var(--text-on-accent);
    position: relative;
    font-size: var(--text-sm);
    font-weight: 700;
    line-height: 1;
  }

  .avatar-initial {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    transform: translateY(0.5px);
  }

  .content {
    flex: 1;
    overflow-y: auto;
    padding: var(--sp-xl) clamp(20px, 3vw, 40px);
    max-width: 1440px;
    margin: 0 auto;
    width: 100%;
  }

  /* --- Course Grid --- */
  .course-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: var(--sp-lg);
  }

  /* --- Course Card --- */
  .course-card {
    position: relative;
    z-index: 1;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: var(--sp-lg) var(--sp-lg);
    display: flex;
    flex-direction: column;
    gap: var(--sp-md);
    transition: all var(--duration-fast) var(--ease);
    box-shadow: var(--shadow-md);
    animation: cardEnter 420ms var(--ease) both;
  }

  .course-card.has-popover {
    z-index: 10;
  }

  .course-card:nth-child(1) { animation-delay: 20ms; }
  .course-card:nth-child(2) { animation-delay: 70ms; }
  .course-card:nth-child(3) { animation-delay: 120ms; }
  .course-card:nth-child(4) { animation-delay: 170ms; }
  .course-card:nth-child(5) { animation-delay: 220ms; }
  .course-card:nth-child(6) { animation-delay: 270ms; }

  .course-card:hover {
    border-color: var(--border-strong);
    box-shadow: var(--shadow-lg);
  }

  .pin-corner {
    position: absolute;
    top: 12px;
    right: 12px;
    z-index: 2;
  }

  .course-card.active {
    border-color: var(--accent);
    box-shadow: var(--shadow-lg);
  }

  /* --- Card Header (Row 1) --- */
  .card-header {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }

  .card-title-row {
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
    min-width: 0;
    padding-right: 34px;
  }

  .card-badge-row {
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
    flex-wrap: wrap;
    min-width: 0;
  }

  .header-right-meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--sp-xs);
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    min-width: 0;
  }

  .meta-version-btn {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    cursor: pointer;
    color: var(--text-tertiary);
    font-size: inherit;
    font-family: inherit;
    line-height: 1;
    border-radius: 3px;
    transition: color var(--duration-fast) var(--ease);
  }

  .meta-version-btn:hover {
    color: var(--accent);
  }

  .version-info-icon {
    color: var(--accent);
    flex-shrink: 0;
  }

  .card-title-btn {
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    text-align: left;
    border-radius: 0;
    min-width: 0;
    flex: 1;
  }

  .card-title-btn:hover .card-title {
    color: var(--accent);
  }

  .card-title {
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
    transition: color var(--duration-fast) var(--ease);
    line-height: 1.15;
    overflow-wrap: anywhere;
  }

  .format-badge {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    background: var(--accent-subtle);
    color: var(--accent);
    padding: 2px 8px;
    border-radius: 10px;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .meta-path {
    font-family: var(--font-mono);
    opacity: 0.8;
    max-width: 300px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta-dot { opacity: 0.4; }

  /* --- Status Pill (inline in header) --- */
  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--success);
    margin-left: var(--sp-xs);
  }

  .status-pulse {
    width: 7px;
    height: 7px;
    background: var(--success);
    border-radius: 50%;
    animation: pulse 2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(29, 118, 72, 0.4); }
    50% { opacity: 0.7; box-shadow: 0 0 0 4px rgba(29, 118, 72, 0); }
  }

  .port-text {
    font-family: var(--font-mono);
    opacity: 0.8;
    margin-left: 2px;
  }

  .card-detail-row {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--sp-sm);
    padding: var(--sp-sm) 0;
    border-top: 1px dashed var(--border);
    border-bottom: 1px dashed var(--border);
  }

  .detail-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .detail-label {
    font-size: 10px;
    color: var(--text-tertiary);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-weight: 600;
  }

  .detail-value {
    font-size: var(--text-sm);
    color: var(--text-secondary);
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .detail-value.running {
    color: var(--success);
  }

  /* --- Card Actions --- */
  .card-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-top: 2px;
    gap: var(--sp-sm);
  }

  .actions-left, .actions-right {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .card-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    height: 32px;
    padding: 0 12px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg-secondary);
    color: var(--text-secondary);
    font-size: var(--text-xs);
    font-weight: 500;
    cursor: pointer;
    transition: all var(--duration-fast) var(--ease);
    white-space: nowrap;
  }

  .actions-left .card-btn {
    min-width: 92px;
  }

  .card-btn:hover:not(:disabled) {
    background: var(--accent-subtle);
    color: var(--accent);
    border-color: var(--accent-subtle);
  }

  .card-btn:active:not(:disabled) {
    transform: scale(0.97);
  }

  .card-btn.primary {
    background: var(--accent);
    color: var(--text-on-accent);
  }

  .card-btn.primary:hover:not(:disabled) {
    background: var(--accent-hover);
    color: var(--text-on-accent);
  }

  .card-btn.primary.active {
    background: var(--error-subtle);
    color: var(--error);
    border-color: var(--error-subtle);
  }

  .card-btn.primary.active:hover:not(:disabled) {
    background: var(--error);
    color: white;
  }

  .card-btn.primary.export {
    background: var(--palette-gray);
    color: white;
    border-color: var(--palette-gray);
  }

  .card-btn.primary.export:hover:not(:disabled) {
    background: var(--palette-gray);
    filter: brightness(1.2);
    color: white;
  }

  .card-btn.primary.deploy {
    background: var(--palette-green);
    color: white;
    border-color: var(--palette-green);
  }

  .card-btn.primary.deploy:hover:not(:disabled) {
    background: var(--palette-green);
    filter: brightness(1.1);
    color: white;
  }

  .card-btn.subtle {
    background: transparent;
    padding: 5px 9px;
    color: var(--text-tertiary);
  }

  .card-btn.subtle:hover:not(:disabled) {
    background: var(--bg-secondary);
    color: var(--text-secondary);
  }

  .card-btn.subtle.danger {
    color: var(--text-tertiary);
  }

  .card-btn.subtle.danger:hover:not(:disabled) {
    background: var(--error-subtle);
    color: var(--error);
    border-color: var(--error-subtle);
  }

  .card-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .btn-spinner {
    width: 12px;
    height: 12px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* --- Skeleton & Empty --- */
  .skeleton-card {
    height: 184px;
    border-radius: var(--radius-lg);
    background: var(--bg-secondary);
    animation: shimmer 1.5s infinite;
  }

  @keyframes shimmer {
    0%, 100% { opacity: 0.5; }
    50% { opacity: 0.8; }
  }

  @keyframes dashboardFadeIn {
    from { opacity: 0; transform: translateY(-3px); }
    to { opacity: 1; transform: translateY(0); }
  }

  @keyframes cardEnter {
    from { opacity: 0; transform: translateY(10px) scale(0.995); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }

  .no-results {
    padding: var(--sp-2xl);
    text-align: center;
  }

  @media (min-width: 1180px) {
    .course-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 1060px) {
    .header {
      flex-wrap: wrap;
      justify-content: flex-start;
      gap: var(--sp-sm);
    }

    .header-center {
      order: 3;
      flex: 1 0 100%;
      max-width: none;
    }

    .header-right {
      margin-left: auto;
    }

    .content {
      padding: var(--sp-lg) var(--sp-md);
    }
  }

  @media (max-width: 760px) {
    .card-header {
      flex-direction: column;
      align-items: flex-start;
      gap: var(--sp-sm);
    }

    .header-right-meta {
      width: 100%;
      flex-wrap: wrap;
      gap: 6px;
    }

    .meta-path {
      max-width: 100%;
    }

    .card-detail-row {
      grid-template-columns: 1fr;
      gap: 6px;
    }

    .card-actions {
      flex-direction: column;
      align-items: stretch;
    }

    .actions-left,
    .actions-right {
      width: 100%;
      justify-content: flex-start;
      flex-wrap: wrap;
    }

    .actions-left .card-btn {
      flex: 1 1 120px;
      min-width: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .header,
    .course-card,
    .status-pulse,
    .btn-spinner {
      animation: none;
    }

    .course-card,
    .course-card:hover,
    .course-card.active,
    .card-btn:hover:not(:disabled),
    .card-btn:active:not(:disabled) {
      transform: none;
    }
  }
  /* --- Export Popover --- */
  .export-btn-wrapper {
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

  /* --- Deploy Popover --- */
  .deploy-btn-wrapper {
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

  .deploy-popover.anchored {
    position: fixed;
    z-index: 1100;
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

  .deploy-popover-input::placeholder {
    color: var(--text-tertiary);
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

  /* --- Deploy toggle rows --- */
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

  /* --- GitHub badge --- */
  .github-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    font-weight: 600;
    padding: 2px 7px;
    border-radius: 10px;
    background: color-mix(in srgb, #6e40c9 18%, transparent);
    color: #8b6cd8;
    white-space: nowrap;
    flex-shrink: 0;
    letter-spacing: 0.03em;
  }

  .cloud-preview-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    font-weight: 600;
    padding: 2px 7px;
    border-radius: 10px;
    white-space: nowrap;
    flex-shrink: 0;
    letter-spacing: 0.03em;
    background: color-mix(in srgb, var(--bg-secondary) 70%, transparent);
    color: var(--text-secondary);
  }

  .cloud-preview-badge.active {
    background: color-mix(in srgb, var(--success) 16%, transparent);
    color: var(--success);
  }

  .cloud-preview-badge.disabled,
  .cloud-preview-badge.missing {
    background: color-mix(in srgb, var(--warning) 12%, transparent);
    color: var(--warning);
  }

  .cloud-preview-badge.expired {
    background: color-mix(in srgb, var(--danger) 14%, transparent);
    color: var(--danger);
  }

  /* --- Deploy button GitHub-locked state --- */
  .card-btn.deploy.github-locked {
    background: color-mix(in srgb, #6e40c9 15%, transparent);
    color: #8b6cd8;
    border-color: color-mix(in srgb, #6e40c9 30%, transparent);
  }

  .card-btn.deploy.github-locked:hover {
    background: color-mix(in srgb, #6e40c9 25%, transparent);
  }

  /* --- GitHub info popover (blocks production, offers preview) --- */
  .github-info-popover {
    gap: var(--sp-sm);
  }

  .github-info-header {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-sm);
    font-weight: 600;
    color: #8b6cd8;
  }

  .github-info-body {
    font-size: var(--text-xs);
    color: var(--text-secondary);
    margin: 0;
    line-height: 1.5;
  }

  /* --- Open in Cloud link button (styled like card-btn) --- */
  a.card-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    text-decoration: none;
    color: inherit;
  }

  /* --- Delete dialog --- */
  .dialog-backdrop {
    position: fixed;
    inset: 0;
    z-index: 200;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    animation: fadeIn 120ms var(--ease);
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .dialog {
    background: var(--bg-elevated);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    padding: var(--sp-xl);
    width: min(420px, 92vw);
    box-shadow: var(--shadow-lg);
    display: flex;
    flex-direction: column;
    gap: var(--sp-md);
    animation: dialogSlideIn 160ms var(--ease);
  }

  @keyframes dialogSlideIn {
    from { opacity: 0; transform: translateY(8px) scale(0.97); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }

  .dialog-title {
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
  }

  .dialog-body {
    font-size: var(--text-sm);
    color: var(--text-secondary);
    margin: 0;
    line-height: 1.5;
  }

  .dialog-cloud-row {
    display: flex;
    flex-direction: column;
    gap: var(--sp-xs);
    padding: var(--sp-md);
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .dialog-cloud-label {
    display: flex;
    align-items: center;
    gap: var(--sp-xs);
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text-primary);
    cursor: pointer;
    user-select: none;
  }

  .dialog-cloud-label input[type="checkbox"] {
    accent-color: var(--accent);
    width: 14px;
    height: 14px;
    cursor: pointer;
    flex-shrink: 0;
  }

  .dialog-cloud-note {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    margin: 0;
    padding-left: 20px;
    line-height: 1.4;
  }

  .dialog-cloud-note.warning {
    color: var(--warning, #f59e0b);
  }

  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--sp-sm);
    margin-top: var(--sp-xs);
  }

  .dialog-cancel,
  .dialog-confirm {
    padding: 6px 16px;
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
    border: none;
    transition: all var(--duration-fast) var(--ease);
  }

  .dialog-cancel {
    background: var(--bg-secondary);
    color: var(--text-secondary);
  }

  .dialog-cancel:hover {
    background: var(--bg-tertiary, var(--border));
  }

  .dialog-confirm.danger {
    background: var(--error, #ef4444);
    color: #fff;
  }

  .dialog-confirm.danger:hover {
    background: color-mix(in srgb, var(--error, #ef4444) 85%, black);
  }
</style>
