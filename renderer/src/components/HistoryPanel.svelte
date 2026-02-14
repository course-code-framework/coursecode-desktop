<script>
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import { showToast } from '../stores/toast.js';

  let { projectPath, onClose, onScrollToChat } = $props();

  let snapshots = $state([]);
  let loading = $state(true);
  let expandedId = $state(null);
  let expandedDiff = $state(null);
  let restoreToast = $state(null);
  let restoreTimeout = null;

  onMount(async () => {
    await loadSnapshots();
  });

  async function loadSnapshots() {
    loading = true;
    try {
      snapshots = await window.api.snapshots.list(projectPath);
    } catch {
      snapshots = [];
    }
    loading = false;
  }

  async function toggleExpand(id) {
    if (expandedId === id) {
      expandedId = null;
      expandedDiff = null;
      return;
    }
    expandedId = id;
    expandedDiff = null;
    try {
      expandedDiff = await window.api.snapshots.diff(projectPath, id);
    } catch {
      expandedDiff = { added: [], modified: [], deleted: [] };
    }
  }

  function handleRestore(snapshot) {
    // Show undo toast with 5-second countdown
    restoreToast = { snapshot, countdown: 5 };

    restoreTimeout = setTimeout(async () => {
      restoreToast = null;
      try {
        await window.api.snapshots.restore(projectPath, snapshot.id);
        await loadSnapshots();
      } catch (err) {
        showToast({ type: 'error', message: `Restore failed: ${err.message}` });
      }
    }, 5000);

    // Countdown
    const interval = setInterval(() => {
      if (!restoreToast) { clearInterval(interval); return; }
      restoreToast = { ...restoreToast, countdown: restoreToast.countdown - 1 };
      if (restoreToast.countdown <= 0) clearInterval(interval);
    }, 1000);
  }

  function cancelRestore() {
    clearTimeout(restoreTimeout);
    restoreToast = null;
  }

  function formatTime(iso) {
    const date = new Date(iso);
    const now = new Date();
    const diff = now - date;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} min ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    if (diff < 172800000) return 'Yesterday';
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function fileCount(summary) {
    if (!summary) return 0;
    return (summary.added?.length || 0) + (summary.modified?.length || 0) + (summary.deleted?.length || 0);
  }
</script>

<div class="history-panel" data-testid="history-panel">
  <div class="history-header">
    <h3>History</h3>
    <button class="btn-ghost btn-sm" onclick={onClose} title="Close">
      <Icon size={16}><path d="M18 6 6 18"/><path d="m6 6 12 12"/></Icon>
    </button>
  </div>

  <div class="history-body">
    {#if loading}
      <div class="history-loading">
        <span class="text-tertiary">Loading history…</span>
      </div>
    {:else if snapshots.length === 0}
      <div class="history-empty">
        <Icon size={32}>
          <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
        </Icon>
        <p>No history yet</p>
        <span class="text-tertiary">Changes are tracked automatically</span>
      </div>
    {:else}
      <div class="timeline">
        {#each snapshots as snap, i}
          <div class="timeline-item" class:expanded={expandedId === snap.id}>
            <div class="timeline-dot"></div>
            <div
              class="timeline-card"
              role="button"
              tabindex="0"
              onclick={() => toggleExpand(snap.id)}
              onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggleExpand(snap.id))}
            >
              <div class="timeline-meta">
                <span class="timeline-time">{formatTime(snap.timestamp)}</span>
                {#if fileCount(snap.summary) > 0}
                  <span class="file-badge">{fileCount(snap.summary)} file{fileCount(snap.summary) !== 1 ? 's' : ''}</span>
                {/if}
              </div>
              <div class="timeline-label">{snap.label}</div>

              {#if expandedId === snap.id}
                <div class="timeline-detail">
                  {#if expandedDiff}
                    {#if expandedDiff.added.length > 0}
                      <div class="diff-group">
                        <span class="diff-type added">+ Added</span>
                        {#each expandedDiff.added as file}
                          <span class="diff-file">{file}</span>
                        {/each}
                      </div>
                    {/if}
                    {#if expandedDiff.modified.length > 0}
                      <div class="diff-group">
                        <span class="diff-type modified">~ Modified</span>
                        {#each expandedDiff.modified as file}
                          <span class="diff-file">{file}</span>
                        {/each}
                      </div>
                    {/if}
                    {#if expandedDiff.deleted.length > 0}
                      <div class="diff-group">
                        <span class="diff-type deleted">− Deleted</span>
                        {#each expandedDiff.deleted as file}
                          <span class="diff-file">{file}</span>
                        {/each}
                      </div>
                    {/if}
                    {#if expandedDiff.added.length === 0 && expandedDiff.modified.length === 0 && expandedDiff.deleted.length === 0}
                      <span class="text-tertiary" style="font-size: 12px;">No file changes in this snapshot</span>
                    {/if}
                  {:else}
                    <span class="text-tertiary" style="font-size: 12px;">Loading…</span>
                  {/if}

                  <div class="timeline-actions">
                    {#if snap.chatIndex != null && onScrollToChat}
                      <button class="btn-ghost btn-sm" onclick={(e) => { e.stopPropagation(); onScrollToChat(snap.chatIndex); }}>
                        View Chat
                      </button>
                    {/if}
                    <button class="btn-secondary btn-sm" onclick={(e) => { e.stopPropagation(); handleRestore(snap); }}>
                      Restore
                    </button>
                  </div>
                </div>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  {#if restoreToast}
    <div class="restore-toast">
      <span>Restoring to "{restoreToast.snapshot.label}" in {restoreToast.countdown}s</span>
      <button class="btn-ghost btn-sm" onclick={cancelRestore}>Undo</button>
    </div>
  {/if}
</div>

<style>
  .history-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg-primary);
    border-left: 1px solid var(--border);
    width: 320px;
    min-width: 280px;
    position: relative;
  }

  .history-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }

  .history-header h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }

  .history-body {
    flex: 1;
    overflow-y: auto;
    padding: 12px 0;
  }

  .history-loading,
  .history-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 48px 24px;
    text-align: center;
    color: var(--text-tertiary);
  }

  .history-empty p {
    margin: 4px 0 0;
    font-weight: 500;
    color: var(--text-secondary);
  }

  /* Timeline */
  .timeline {
    padding: 0 16px;
  }

  .timeline-item {
    position: relative;
    padding-left: 20px;
    padding-bottom: 16px;
  }

  .timeline-item:not(:last-child)::before {
    content: '';
    position: absolute;
    left: 5px;
    top: 12px;
    bottom: 0;
    width: 1px;
    background: var(--border);
  }

  .timeline-dot {
    position: absolute;
    left: 0;
    top: 6px;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: var(--bg-primary);
    border: 2px solid var(--text-tertiary);
  }

  .timeline-item:first-child .timeline-dot {
    border-color: var(--accent);
    background: var(--accent);
  }

  .timeline-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 12px;
    cursor: pointer;
    transition: background 150ms;
  }

  .timeline-card:hover {
    background: var(--bg-secondary);
  }

  .timeline-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 2px;
  }

  .timeline-time {
    font-size: 11px;
    color: var(--text-tertiary);
  }

  .file-badge {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--bg-secondary);
    color: var(--text-secondary);
  }

  .timeline-label {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-primary);
    line-height: 1.3;
  }

  /* Expanded detail */
  .timeline-detail {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--border);
  }

  .diff-group {
    margin-bottom: 6px;
  }

  .diff-type {
    display: block;
    font-size: 11px;
    font-weight: 600;
    margin-bottom: 2px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .diff-type.added { color: var(--success); }
  .diff-type.modified { color: var(--warning); }
  .diff-type.deleted { color: var(--error); }

  .diff-file {
    display: block;
    font-size: 12px;
    font-family: var(--font-mono);
    color: var(--text-secondary);
    padding: 1px 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .timeline-actions {
    display: flex;
    gap: 8px;
    margin-top: 8px;
    justify-content: flex-end;
  }

  /* Restore toast */
  .restore-toast {
    position: absolute;
    bottom: 16px;
    left: 16px;
    right: 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    font-size: 13px;
    z-index: 10;
  }
</style>
