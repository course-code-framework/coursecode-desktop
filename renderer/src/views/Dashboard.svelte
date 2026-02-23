<script>
  import { onMount, onDestroy } from 'svelte';
  import { projects, loading, refreshProjects } from '../stores/projects.js';
  import { user, loadCloudUser } from '../stores/auth.js';
  import { settings } from '../stores/settings.js';
  import { tabs } from '../stores/tabs.js';
  import EmptyState from '../components/EmptyState.svelte';
  import Icon from '../components/Icon.svelte';
  import { showToast } from '../stores/toast.js';

  let { onCreateNew, onOpenProject, onCloseProject, onOpenSettings } = $props();

  let previewStatuses = $state({});
  let searchQuery = $state('');
  let formatFilter = $state('all');
  let sortBy = $state('modified'); // 'modified' | 'name' | 'format' | 'created'
  let pinnedPaths = $state(new Set());
  let actionInProgress = $state({});
  let deployPopover = $state(null);
  let deployReason = $state('');
  let statusInterval = null;

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

  onMount(() => {
    refreshProjects();
    loadCloudUser();
    refreshStatuses();
    statusInterval = setInterval(refreshStatuses, 3000);

    // Load pinned projects from localStorage
    try {
      const saved = localStorage.getItem('coursecode-pinned-projects');
      if (saved) pinnedPaths = new Set(JSON.parse(saved));
    } catch { /* ignore */ }
  });

  onDestroy(() => {
    if (statusInterval) clearInterval(statusInterval);
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

  async function exportBuild(e, project) {
    e.stopPropagation();
    actionInProgress = { ...actionInProgress, [project.path]: 'building' };
    try {
      const result = await window.api.build.export(project.path, project.format);
      if (result.zipPath) {
        showToast({
          type: 'success',
          message: `Build complete — ${(result.size / 1024).toFixed(0)} KB`,
          action: { label: 'Reveal in Finder', handler: () => window.api.tools.openInFinder(result.zipPath) }
        });
      }
    } catch (err) {
      showToast({ type: 'error', message: `Build failed: ${err.message}` });
    }
    delete actionInProgress[project.path];
    actionInProgress = { ...actionInProgress };
  }

  function openDeployPopover(e, project) {
    e.stopPropagation();
    if (deployPopover === project.path) {
      deployPopover = null;
    } else {
      deployPopover = project.path;
      deployReason = '';
    }
  }

  async function confirmDeploy(e, project) {
    e.stopPropagation();
    deployPopover = null;
    actionInProgress = { ...actionInProgress, [project.path]: 'deploying' };
    try {
      const options = deployReason.trim() ? { message: deployReason.trim() } : undefined;
      const result = await window.api.cloud.deploy(project.path, options);
      showToast({
        type: 'success',
        message: 'Deployed successfully!',
        action: result?.deployUrl ? { label: 'Open in Browser', handler: () => window.open(result.deployUrl) } : undefined
      });
    } catch (err) {
      showToast({ type: 'error', message: `Deploy failed: ${err.message}` });
    }
    deployReason = '';
    delete actionInProgress[project.path];
    actionInProgress = { ...actionInProgress };
  }

  function handleDeployPopoverKeydown(e, project) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      deployPopover = null;
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      confirmDeploy(e, project);
    }
  }

  function openInVSCode(e, path) {
    e.stopPropagation();
    window.api.tools.openInVSCode(path);
  }

  function openInFinder(e, path) {
    e.stopPropagation();
    window.api.tools.openCourseFolder(path);
  }

  function openTerminal(e, path) {
    e.stopPropagation();
    window.api.tools.openTerminal(path);
  }

  async function deleteCourse(e, project) {
    e.stopPropagation();
    const path = project.path;
    if (actionInProgress[path]) return;

    // Use toast-with-undo instead of window.confirm
    actionInProgress = { ...actionInProgress, [path]: 'deleting' };
    let cancelled = false;
    const toastId = showToast({
      type: 'warning',
      message: `Moving "${project.title || project.name}" to Trash…`,
      action: {
        label: 'Undo',
        handler: () => {
          cancelled = true;
          delete actionInProgress[path];
          actionInProgress = { ...actionInProgress };
        }
      },
      duration: 5000
    });

    // Wait 5 seconds, then delete if not cancelled
    setTimeout(async () => {
      if (cancelled) return;
      try {
        if (isTabOpen(path)) await onCloseProject?.(path);
        try {
          const status = await window.api.preview.status(path);
          if (status === 'running') await window.api.preview.stop(path);
        } catch { /* ignore */ }
        await window.api.projects.delete(path);
        await refreshProjects();
        await refreshStatuses();
        showToast({ type: 'success', message: `"${project.title || project.name}" moved to Trash.`, duration: 3000 });
      } catch (err) {
        showToast({ type: 'error', message: `Delete failed: ${err.message}` });
      } finally {
        delete actionInProgress[path];
        actionInProgress = { ...actionInProgress };
      }
    }, 5000);
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
          <div class="avatar">{$user.email?.[0]?.toUpperCase() || 'U'}</div>
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

          <div class="course-card" class:active={tabOpen}>
            <!-- Row 1: Title left, meta right -->
            <div class="card-header">
              <div class="card-header-left">
                <button
                  class="pin-btn"
                  class:pinned={pinnedPaths.has(project.path)}
                  onclick={(e) => togglePin(e, project)}
                  title={pinnedPaths.has(project.path) ? 'Unpin' : 'Pin to top'}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill={pinnedPaths.has(project.path) ? 'currentColor' : 'none'}>
                    <path d="M8 1.5l1.76 3.57 3.94.57-2.85 2.78.67 3.93L8 10.52l-3.52 1.83.67-3.93L2.3 5.64l3.94-.57L8 1.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
                  </svg>
                </button>
                <button class="card-title-btn" onclick={() => onOpenProject(project.path, project.title)}>
                  <h3 class="card-title">{project.title}</h3>
                </button>
                <span class="format-badge">{formatLabels[project.format] || project.format}</span>
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
                  <span class="meta-version">v{project.frameworkVersion}</span>
                {/if}
              </div>
            </div>

            <div class="card-detail-row">
                <span class="detail-item">
                <span class="detail-label">Status</span>
                <span class="detail-value" class:running={running}>{running ? 'Preview Running' : 'Ready to Preview'}</span>
              </span>
              <span class="detail-item">
                <span class="detail-label">Output</span>
                <span class="detail-value">{formatLabels[project.format] || project.format}</span>
              </span>
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

                <button
                  class="card-btn primary export"
                  onclick={(e) => exportBuild(e, project)}
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

                <div class="deploy-btn-wrapper">
                  <button
                    class="card-btn primary deploy"
                    onclick={(e) => { e.stopPropagation(); openDeployPopover(e, project); }}
                    disabled={!!inProgress}
                    title="Deploy"
                  >
                    {#if inProgress === 'deploying'}
                      <div class="btn-spinner"></div>
                    {:else}
                      <Icon size={14}>
                        <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/>
                        <path d="M12 12v9"/>
                        <path d="m16 16-4-4-4 4"/>
                      </Icon>
                    {/if}
                    Deploy
                  </button>

                  {#if deployPopover === project.path}
                    <div class="deploy-popover" role="dialog" aria-label="Deploy reason">
                      <label class="deploy-popover-label" for="deploy-reason-{project.path}">Deploy reason <span class="optional-tag">optional</span></label>
                      <input
                        id="deploy-reason-{project.path}"
                        type="text"
                        class="deploy-popover-input"
                        placeholder="e.g. Fixed quiz on slide 3"
                        bind:value={deployReason}
                        onkeydown={(e) => handleDeployPopoverKeydown(e, project)}
                      />
                      <div class="deploy-popover-actions">
                        <button class="deploy-popover-cancel" onclick={(e) => { e.stopPropagation(); deployPopover = null; }}>Cancel</button>
                        <button class="deploy-popover-confirm" onclick={(e) => confirmDeploy(e, project)}>Deploy</button>
                      </div>
                    </div>
                  {/if}
                </div>
              </div>

              <div class="actions-right">
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
                <button
                  class="card-btn subtle danger"
                  onclick={(e) => deleteCourse(e, project)}
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
    gap: var(--sp-xs);
    flex-shrink: 0;
  }

  .avatar-btn { padding: 4px; }

  .avatar {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: var(--accent);
    color: var(--text-on-accent);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: var(--text-xs);
    font-weight: 600;
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

  .course-card.active {
    border-color: var(--accent);
    box-shadow: var(--shadow-lg);
  }

  /* --- Card Header (Row 1) --- */
  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-md);
  }

  .card-header-left {
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
    min-width: 0;
  }

  .header-right-meta {
    display: flex;
    align-items: center;
    gap: var(--sp-xs);
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    flex-shrink: 0;
  }

  .card-title-btn {
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    text-align: left;
    border-radius: 0;
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
  /* --- Deploy Popover --- */
  .deploy-btn-wrapper {
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
