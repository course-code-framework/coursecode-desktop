<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import MessageBubble from '../components/MessageBubble.svelte';
  import MentionDropdown from '../components/MentionDropdown.svelte';
  import ModelPicker from '../components/ModelPicker.svelte';
  import Icon from '../components/Icon.svelte';
  import { showToast } from '../stores/toast.js';
  import {
    messages, streaming, streamingText, activeTools,
    sessionUsage, sessionCredits, mentionIndex, aiMode, credits, chatPlan,
    subscribeToChatEvents, unsubscribeFromChatEvents,
    sendMessage, stopGeneration, clearChat, loadChatHistory, loadCredits,
    refreshMentionIndex, formatTokens, formatCost
  } from '../stores/chat.js';

  let { projectPath, refCount = 0, onOpenRefs, onOpenOutline, onSnapshotRestored } = $props();

  let inputText = $state('');
  let inputEl = $state(null);
  let chatBodyEl = $state(null);

  // Mention state
  let showMentions = $state(false);
  let mentionQuery = $state('');
  let mentionSelectedIndex = $state(0);
  let filteredMentions = $derived(filterMentions(mentionQuery));
  let unsubNewChat = null;

  // Workflow state
  let workflowActive = $state(false);
  let workflowId = $state(null);
  let workflowSteps = $state([]);
  let workflowError = $state(null);
  let hasOutline = $state(false);
  let unsubWorkflow = null;
  let walkthroughDismissed = $state(false);
  let expandedChanges = $state(new Set());
  let expandedDiffs = $state(new Set());
  let loadingDiffs = $state(new Set());
  let applyingFileOps = $state(new Set());
  let diffCache = $state({});
  let restoringSnapshotId = $state(null);
  let historyReady = $state(false);

  // --- Lifecycle ---

  onMount(async () => {
    subscribeToChatEvents();
    historyReady = false;
    await loadChatHistory(projectPath);
    await refreshMentionIndex(projectPath);
    if ($aiMode === 'cloud') {
      await loadCredits();
    }
    historyReady = true;
    scrollToBottom();

    // Listen for menu bar "New Chat" command
    unsubNewChat = window.api.chat.onNewChat?.(() => {
      handleClear();
    });

    // Check if outline exists
    checkOutline();

    // Subscribe to workflow progress
    unsubWorkflow = window.api.workflow.onProgress((data) => {
      if (data.type === 'step' || data.type === 'slideComplete') {
        workflowSteps = [...workflowSteps, data.message];
      } else if (data.type === 'complete') {
        workflowSteps = [...workflowSteps, '✓ ' + data.message];
        workflowActive = false;
        workflowId = null;
        checkOutline();
        refreshMentionIndex(projectPath);
      } else if (data.type === 'error') {
        workflowError = data.message;
        workflowActive = false;
        workflowId = null;
      } else if (data.type === 'cancelled') {
        workflowActive = false;
        workflowId = null;
        workflowSteps = [...workflowSteps, '— Cancelled'];
      }
    });
  });

  onDestroy(() => {
    unsubscribeFromChatEvents();
    unsubNewChat?.();
    unsubWorkflow?.();
  });

  // Auto-scroll on new messages
  $effect(() => {
    // Subscribe to changes
    $messages;
    $streamingText;
    tick().then(scrollToBottom);
  });

  function scrollToBottom() {
    if (!chatBodyEl) return;

    // Keep onboarding/walkthrough content anchored at the top.
    if ($messages.length === 0 && !$streaming && !$streamingText) {
      chatBodyEl.scrollTop = 0;
      return;
    }

    chatBodyEl.scrollTop = chatBodyEl.scrollHeight;
  }

  // --- Workflow functions ---

  async function checkOutline() {
    try {
      const result = await window.api.outline.load(projectPath);
      hasOutline = result.exists;
    } catch { hasOutline = false; }
  }

  async function startBuildOutline() {
    if (workflowActive || refCount === 0) return;
    workflowActive = true;
    workflowId = 'build-outline';
    workflowSteps = [];
    workflowError = null;
    await window.api.workflow.run('build-outline', projectPath);
  }

  async function startBuildCourse() {
    if (workflowActive || !hasOutline) return;
    workflowActive = true;
    workflowId = 'build-course';
    workflowSteps = [];
    workflowError = null;
    await window.api.workflow.run('build-course', projectPath);
  }

  async function handleCancelWorkflow() {
    await window.api.workflow.cancel(projectPath);
  }

  // --- Mention filtering ---

  function mentionLabel(item) {
    return item.title || item.filename || item.id || '';
  }

  function normalizeMentionToken(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/^@/, '')
      .trim();
  }

  function findMentionByToken(token) {
    const normalized = normalizeMentionToken(token);
    if (!normalized) return null;
    const idx = $mentionIndex;
    const all = [
      ...(idx.slides || []),
      ...(idx.refs || []),
      ...(idx.interactions || [])
    ];

    // Exact label match first.
    let found = all.find(item => normalizeMentionToken(mentionLabel(item)) === normalized);
    if (found) return found;

    // Ref convenience: allow matching without .md suffix.
    found = all.find(item => {
      const label = normalizeMentionToken(mentionLabel(item));
      if (!label) return false;
      if (label === normalized) return true;
      if (item.type === 'ref' && label.endsWith('.md') && label.slice(0, -3) === normalized) return true;
      return false;
    });
    if (found) return found;

    // Fallback: single contains match (avoid ambiguous injection).
    const partial = all.filter(item => normalizeMentionToken(mentionLabel(item)).includes(normalized));
    return partial.length === 1 ? partial[0] : null;
  }

  function collectInlineMentions(text) {
    const matches = text.match(/@([^\s@]+)/g) || [];
    const resolved = [];
    const seen = new Set();

    for (const token of matches) {
      const mention = findMentionByToken(token);
      if (!mention) continue;
      const key = `${mention.type}:${mention.id || mention.filename || mention.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      resolved.push(mention);
    }
    return resolved;
  }

  function filterMentions(query) {
    const q = query.toLowerCase();
    const idx = $mentionIndex;
    const all = [
      ...(idx.slides || []),
      ...(idx.refs || []),
      ...(idx.interactions || [])
    ];
    if (!q) return all.slice(0, 10);
    return all.filter(item => {
      const label = (item.title || item.filename || item.id || '').toLowerCase();
      return label.includes(q);
    }).slice(0, 10);
  }

  // --- Input handling ---

  let selectedMentions = $state([]);

  function handleInput(e) {
    const text = e.target.value;
    inputText = text;

    // Check for @ mention trigger
    const cursorPos = e.target.selectionStart;
    const textBefore = text.substring(0, cursorPos);
    const atMatch = textBefore.match(/@([^\s@]*)$/);

    if (atMatch) {
      showMentions = true;
      mentionQuery = atMatch[1];
      mentionSelectedIndex = 0;
    } else {
      showMentions = false;
      mentionQuery = '';
    }
  }

  function handleMentionSelect(item) {
    // Replace the @query with the mention
    const cursorPos = inputEl?.selectionStart || inputText.length;
    const textBefore = inputText.substring(0, cursorPos);
    const textAfter = inputText.substring(cursorPos);
    const atMatch = textBefore.match(/@([^\s@]*)$/);

    if (atMatch) {
      const label = item.title || item.filename || item.id;
      const before = textBefore.substring(0, atMatch.index);
      inputText = `${before}@${label} ${textAfter}`;
      selectedMentions = [...selectedMentions, item];
    }

    showMentions = false;
    mentionQuery = '';
    inputEl?.focus();
  }

  function handleKeydown(e) {
    if (showMentions && filteredMentions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        mentionSelectedIndex = Math.min(mentionSelectedIndex + 1, filteredMentions.length - 1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        mentionSelectedIndex = Math.max(mentionSelectedIndex - 1, 0);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        handleMentionSelect(filteredMentions[mentionSelectedIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        showMentions = false;
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  async function handleSend() {
    const text = inputText.trim();
    if (!text || $streaming) return;

    const mentions = [...selectedMentions, ...collectInlineMentions(text)];
    const deduped = [];
    const seen = new Set();
    for (const m of mentions) {
      const key = `${m.type}:${m.id || m.filename || m.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(m);
    }
    inputText = '';
    selectedMentions = [];
    showMentions = false;

    await sendMessage(projectPath, text, deduped);
  }

  async function handleStop() {
    await stopGeneration(projectPath);
  }

  async function handleClear() {
    await clearChat(projectPath);
    inputEl?.focus();
  }

  function handleGlobalKeydown(e) {
    // Cmd/Ctrl+Shift+N → New Chat
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'N') {
      e.preventDefault();
      if ($messages.length > 0) handleClear();
    }
  }

  // Auto-resize textarea
  function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 150) + 'px';
  }

  let walkthroughSteps = $derived(() => {
    const refsReady = refCount > 0;
    const outlineReady = hasOutline;
    const slidesReady = ($mentionIndex?.slides?.length || 0) > 0;
    return [
      { id: 'refs', label: 'Add references', done: refsReady },
      { id: 'outline', label: 'Build and review outline', done: outlineReady },
      { id: 'slides', label: 'Generate slides from outline', done: slidesReady }
    ];
  });

  let showWalkthrough = $derived(!walkthroughDismissed && !($mentionIndex?.slides?.length > 0 && hasOutline && refCount > 0));

  function runWalkthroughAction() {
    const refsReady = refCount > 0;
    const outlineReady = hasOutline;
    if (!refsReady) {
      onOpenRefs?.();
      return;
    }
    if (!outlineReady) {
      startBuildOutline();
      return;
    }
    startBuildCourse();
  }

  function totalChanged(message) {
    return (message.added?.length || 0) + (message.modified?.length || 0) + (message.deleted?.length || 0);
  }

  function isExpanded(id) {
    return expandedChanges.has(id);
  }

  function toggleExpanded(id) {
    const next = new Set(expandedChanges);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expandedChanges = next;
  }

  function openPath(path) {
    if (!path) return;
    const event = new CustomEvent('openfile', { detail: { path }, bubbles: true });
    document.dispatchEvent(event);
  }

  function getDiffKey(snapshotId, filepath) {
    return `${snapshotId}::${filepath}`;
  }

  function getApplyKey(snapshotId, filepath, source) {
    return `${snapshotId}::${filepath}::${source}`;
  }

  function isDiffExpanded(snapshotId, filepath) {
    return expandedDiffs.has(getDiffKey(snapshotId, filepath));
  }

  function isDiffLoading(snapshotId, filepath) {
    return loadingDiffs.has(getDiffKey(snapshotId, filepath));
  }

  function isApplying(snapshotId, filepath, source) {
    return applyingFileOps.has(getApplyKey(snapshotId, filepath, source));
  }

  function getDiffData(snapshotId, filepath) {
    return diffCache[getDiffKey(snapshotId, filepath)] || null;
  }

  function linePrefix(type) {
    if (type === 'add') return '+';
    if (type === 'remove') return '-';
    return ' ';
  }

  async function toggleFileDiff(snapshotId, filepath) {
    if (!snapshotId || !filepath) return;
    const key = getDiffKey(snapshotId, filepath);
    const nextExpanded = new Set(expandedDiffs);
    if (nextExpanded.has(key)) {
      nextExpanded.delete(key);
      expandedDiffs = nextExpanded;
      return;
    }

    nextExpanded.add(key);
    expandedDiffs = nextExpanded;

    if (diffCache[key]) return;

    const nextLoading = new Set(loadingDiffs);
    nextLoading.add(key);
    loadingDiffs = nextLoading;
    try {
      const result = await window.api.snapshots.fileDiff(projectPath, snapshotId, filepath);
      diffCache = { ...diffCache, [key]: result };
    } catch (err) {
      diffCache = {
        ...diffCache,
        [key]: {
          status: 'missing',
          filepath,
          hunks: [{
            oldStart: 1,
            newStart: 1,
            lines: [{ type: 'context', text: `Unable to load diff: ${err?.message || 'Unknown error'}`, oldLine: null, newLine: null }]
          }]
        }
      };
    } finally {
      const doneLoading = new Set(loadingDiffs);
      doneLoading.delete(key);
      loadingDiffs = doneLoading;
    }
  }

  async function applyFileVersion(snapshotId, filepath, source) {
    if (!snapshotId || !filepath) return;
    const applyKey = getApplyKey(snapshotId, filepath, source);
    const nextApplying = new Set(applyingFileOps);
    nextApplying.add(applyKey);
    applyingFileOps = nextApplying;

    try {
      const payload = await window.api.snapshots.applyFileVersion(projectPath, snapshotId, filepath, source);
      const op = payload?.result || null;
      const snapshot = payload?.snapshot || null;
      const changes = payload?.changes || { added: [], modified: [], deleted: [] };

      if (snapshot || totalChanged({ ...changes })) {
        messages.update(msgs => [
          ...msgs,
          {
            role: 'system',
            type: 'changeSummary',
            label: snapshot?.label || (source === 'snapshot' ? `Applied snapshot version: ${filepath}` : `Applied previous version: ${filepath}`),
            timestamp: snapshot?.timestamp || new Date().toISOString(),
            added: changes.added || [],
            modified: changes.modified || [],
            deleted: changes.deleted || [],
            snapshotId: snapshot?.id || null
          }
        ]);
      }

      if (op?.status === 'deleted') {
        showToast({ type: 'success', message: 'Applied version removed this file from the project.' });
      } else {
        showToast({ type: 'success', message: source === 'snapshot' ? 'Applied snapshot version.' : 'Applied previous version.' });
        openPath(filepath);
      }

      await refreshMentionIndex(projectPath);
    } catch (err) {
      showToast({ type: 'error', message: `File update failed: ${err?.message || 'Unknown error'}` });
    } finally {
      const doneApplying = new Set(applyingFileOps);
      doneApplying.delete(applyKey);
      applyingFileOps = doneApplying;
    }
  }

  async function restoreSnapshot(snapshotId) {
    if (!snapshotId || restoringSnapshotId) return;
    restoringSnapshotId = snapshotId;
    try {
      const result = await window.api.snapshots.restore(projectPath, snapshotId);
      await loadChatHistory(projectPath);
      onSnapshotRestored?.(result);
    } catch (err) {
      showToast({ type: 'error', message: `Restore failed: ${err?.message || 'Unknown error'}` });
    } finally {
      restoringSnapshotId = null;
    }
  }

  function formatStreamingHtml(text) {
    const escaped = String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return escaped.replace(/\n/g, '<br>');
  }
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<div class="chat-panel" data-testid="chat-panel">
  <!-- Chat header with New Chat button -->
  {#if $messages.length > 0}
    <div class="chat-header">
      <button class="new-chat-btn" onclick={handleClear} title="New conversation (⌘⇧N)">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M13.5 2.5l-1-1-4 4H5v3.5l-1.5 1.5H14V7l-4.5-4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M2 14h12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
        </svg>
        New Chat
      </button>
    </div>
  {/if}

  <!-- Messages -->
  <div class="chat-body" bind:this={chatBodyEl}>
    {#if !historyReady}
      <div class="chat-loading-state" data-testid="chat-loading-state">
        <span class="text-tertiary">Loading conversation…</span>
      </div>
    {:else}
    {#if showWalkthrough}
      <div class="course-walkthrough">
        <div class="walkthrough-head">
          <div>
            <span class="walkthrough-kicker">Course Walkthrough</span>
            <h4 class="walkthrough-title">Build your course in three guided steps</h4>
          </div>
          <button class="walkthrough-dismiss" onclick={() => walkthroughDismissed = true} title="Dismiss">×</button>
        </div>

        <div class="walkthrough-steps">
          {#each walkthroughSteps as step}
            <div class="walkthrough-step" class:done={step.done}>
              <span class="walkthrough-dot">{step.done ? '✓' : ''}</span>
              <span>{step.label}</span>
            </div>
          {/each}
        </div>

        <div class="walkthrough-actions">
          <button class="btn-secondary btn-sm" onclick={() => onOpenRefs?.()}>Open References</button>
          <button class="btn-secondary btn-sm" onclick={() => onOpenOutline?.()}>Open Outline Editor</button>
          <button class="btn-primary btn-sm" onclick={runWalkthroughAction} disabled={workflowActive}>
            {#if refCount === 0}
              Add References to Start
            {:else if !hasOutline}
              Build Outline
            {:else}
              Build Course
            {/if}
          </button>
        </div>
      </div>
    {/if}

    {#if $chatPlan.status !== 'idle' && $chatPlan.steps.length > 0}
      <div class="execution-plan">
        <div class="execution-plan-title">Course Plan</div>
        <div class="execution-steps">
          {#each $chatPlan.steps as step}
            <div class="execution-step" class:done={step.status === 'completed'} class:active={step.status === 'in_progress'} class:error={step.status === 'error'}>
              <span class="execution-dot"></span>
              <span>{step.label}</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    {#if $messages.length === 0 && !$streaming}
      <div class="empty-state" class:compact={showWalkthrough}>
        <div class="empty-icon">
          <Icon size={28}>
            <path d="m12 3 2.2 4.8L19 10l-4.8 2.2L12 17l-2.2-4.8L5 10l4.8-2.2Z"/>
          </Icon>
        </div>
        <h3>{showWalkthrough ? 'Or ask for anything' : 'What would you like to create?'}</h3>
        <p>
          {#if showWalkthrough}
            Use the walkthrough above for the guided path, or type any request below for direct help.
          {:else}
            Describe the course you want, and I'll build it for you. You can also drop reference documents in the References panel above.
          {/if}
        </p>
        <div class="quick-actions">
          {#if !showWalkthrough}
            <button class="quick-btn workflow" onclick={startBuildOutline} disabled={workflowActive || refCount === 0}>
              <span class="quick-label">
                <Icon size={14}>
                  <path d="M9 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/>
                  <path d="M12 8h6M12 12h6M12 16h4"/>
                </Icon>
                Build Course Outline
              </span>
              <span class="quick-desc">{refCount > 0 ? 'Analyze your references and create a structured outline' : 'Add references first to generate a useful outline'}</span>
            </button>
            <button class="quick-btn workflow" onclick={startBuildCourse} disabled={workflowActive || !hasOutline}>
              <span class="quick-label">
                <Icon size={14}>
                  <path d="M3 20h18M6 20V8l6-4 6 4v12M10 20v-5h4v5"/>
                </Icon>
                Build Course from Outline
              </span>
              <span class="quick-desc">{hasOutline ? 'Generate all slides from your course outline' : 'Build an outline first'}</span>
            </button>
          {/if}
          <button class="quick-btn" onclick={() => { inputText = 'What can you help me with?'; inputEl?.focus(); }}>
            <span class="quick-label">
              <Icon size={14}>
                <circle cx="12" cy="12" r="9"/>
                <path d="M9.5 9a2.5 2.5 0 1 1 4.1 1.9c-.9.7-1.6 1.1-1.6 2.1"/>
                <circle cx="12" cy="16.6" r="0.7" fill="currentColor" stroke="none"/>
              </Icon>
              What can you do?
            </span>
          </button>
        </div>
      </div>

      {#if workflowActive || workflowSteps.length > 0}
        <div class="workflow-progress">
          <div class="workflow-header">
            <span class="workflow-title">
              <Icon size={13}>
                {#if workflowId === 'build-outline'}
                  <path d="M9 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/>
                  <path d="M12 8h6M12 12h6M12 16h4"/>
                {:else}
                  <path d="M3 20h18M6 20V8l6-4 6 4v12M10 20v-5h4v5"/>
                {/if}
              </Icon>
              {workflowId === 'build-outline' ? 'Building Outline' : 'Building Course'}
            </span>
            {#if workflowActive}
              <button class="btn-ghost btn-sm" onclick={handleCancelWorkflow}>Cancel</button>
            {/if}
          </div>
          <div class="workflow-steps">
            {#each workflowSteps as step}
              <div class="workflow-step">{step}</div>
            {/each}
            {#if workflowActive}
              <div class="workflow-step active">
                <span class="workflow-spinner"></span>
                Working…
              </div>
            {/if}
            {#if workflowError}
              <div class="workflow-step error">{workflowError}</div>
            {/if}
          </div>
        </div>
      {/if}
    {:else}
      {#each $messages as message, idx}
        {#if message.type === 'changeSummary'}
          {@const changeId = message.snapshotId || `change-${idx}`}
          <div class="change-summary-card">
            <div class="change-summary-icon">
              <Icon size={14}>
                <path d="M4 20h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-9l-5 5v9a2 2 0 0 0 2 2Z"/>
                <path d="M14 4v5h-5"/>
              </Icon>
            </div>
            <div class="change-summary-body">
              <span class="change-summary-title">
                {totalChanged(message)} file{totalChanged(message) !== 1 ? 's' : ''} changed
              </span>
              <span class="change-summary-detail">
                {#if message.added?.length > 0}+{message.added.length} added{/if}
                {#if message.modified?.length > 0}{message.added?.length > 0 ? ' · ' : ''}~{message.modified.length} modified{/if}
                {#if message.deleted?.length > 0}{(message.added?.length > 0 || message.modified?.length > 0) ? ' · ' : ''}−{message.deleted.length} deleted{/if}
              </span>
              <div class="change-summary-actions">
                <button class="btn-ghost btn-sm" onclick={() => toggleExpanded(changeId)}>
                  {isExpanded(changeId) ? 'Hide Files' : 'Show Files'}
                </button>
                {#if message.snapshotId}
                  <button class="btn-secondary btn-sm" disabled={restoringSnapshotId === message.snapshotId} onclick={() => restoreSnapshot(message.snapshotId)}>
                    {restoringSnapshotId === message.snapshotId ? 'Restoring…' : 'Restore Point'}
                  </button>
                {/if}
              </div>
              {#if isExpanded(changeId)}
                <div class="change-files">
                  {#each message.added || [] as file}
                    <div class="change-file-row">
                      <button class="change-file added" onclick={() => openPath(file)}>+ {file}</button>
                      {#if message.snapshotId}
                        <button class="change-file-diff-btn" onclick={() => toggleFileDiff(message.snapshotId, file)}>
                          {isDiffExpanded(message.snapshotId, file) ? 'Hide Diff' : 'View Diff'}
                        </button>
                      {/if}
                    </div>
                    {#if message.snapshotId && isDiffExpanded(message.snapshotId, file)}
                      {@const diffData = getDiffData(message.snapshotId, file)}
                      <div class="inline-diff">
                        <div class="inline-diff-actions">
                          <button
                            class="btn-secondary btn-sm"
                            disabled={isApplying(message.snapshotId, file, 'snapshot')}
                            onclick={() => applyFileVersion(message.snapshotId, file, 'snapshot')}
                          >
                            {isApplying(message.snapshotId, file, 'snapshot') ? 'Applying…' : 'Use Snapshot Version'}
                          </button>
                          <button
                            class="btn-ghost btn-sm"
                            disabled={isApplying(message.snapshotId, file, 'parent')}
                            onclick={() => applyFileVersion(message.snapshotId, file, 'parent')}
                          >
                            {isApplying(message.snapshotId, file, 'parent') ? 'Applying…' : 'Use Previous Version'}
                          </button>
                        </div>
                        {#if isDiffLoading(message.snapshotId, file)}
                          <div class="inline-diff-empty">Loading diff…</div>
                        {:else if diffData?.hunks?.length > 0}
                          {#each diffData.hunks as hunk}
                            <div class="diff-hunk">
                              <div class="diff-hunk-header">@@ -{hunk.oldStart} +{hunk.newStart} @@</div>
                              {#each hunk.lines as line}
                                <div class="diff-line" class:add={line.type === 'add'} class:remove={line.type === 'remove'}>
                                  <span class="diff-line-num">{line.oldLine ?? ''}</span>
                                  <span class="diff-line-num">{line.newLine ?? ''}</span>
                                  <span class="diff-line-prefix">{linePrefix(line.type)}</span>
                                  <span class="diff-line-text">{line.text}</span>
                                </div>
                              {/each}
                            </div>
                          {/each}
                        {:else}
                          <div class="inline-diff-empty">No line-level differences.</div>
                        {/if}
                      </div>
                    {/if}
                  {/each}
                  {#each message.modified || [] as file}
                    <div class="change-file-row">
                      <button class="change-file modified" onclick={() => openPath(file)}>~ {file}</button>
                      {#if message.snapshotId}
                        <button class="change-file-diff-btn" onclick={() => toggleFileDiff(message.snapshotId, file)}>
                          {isDiffExpanded(message.snapshotId, file) ? 'Hide Diff' : 'View Diff'}
                        </button>
                      {/if}
                    </div>
                    {#if message.snapshotId && isDiffExpanded(message.snapshotId, file)}
                      {@const diffData = getDiffData(message.snapshotId, file)}
                      <div class="inline-diff">
                        <div class="inline-diff-actions">
                          <button
                            class="btn-secondary btn-sm"
                            disabled={isApplying(message.snapshotId, file, 'snapshot')}
                            onclick={() => applyFileVersion(message.snapshotId, file, 'snapshot')}
                          >
                            {isApplying(message.snapshotId, file, 'snapshot') ? 'Applying…' : 'Use Snapshot Version'}
                          </button>
                          <button
                            class="btn-ghost btn-sm"
                            disabled={isApplying(message.snapshotId, file, 'parent')}
                            onclick={() => applyFileVersion(message.snapshotId, file, 'parent')}
                          >
                            {isApplying(message.snapshotId, file, 'parent') ? 'Applying…' : 'Use Previous Version'}
                          </button>
                        </div>
                        {#if isDiffLoading(message.snapshotId, file)}
                          <div class="inline-diff-empty">Loading diff…</div>
                        {:else if diffData?.hunks?.length > 0}
                          {#each diffData.hunks as hunk}
                            <div class="diff-hunk">
                              <div class="diff-hunk-header">@@ -{hunk.oldStart} +{hunk.newStart} @@</div>
                              {#each hunk.lines as line}
                                <div class="diff-line" class:add={line.type === 'add'} class:remove={line.type === 'remove'}>
                                  <span class="diff-line-num">{line.oldLine ?? ''}</span>
                                  <span class="diff-line-num">{line.newLine ?? ''}</span>
                                  <span class="diff-line-prefix">{linePrefix(line.type)}</span>
                                  <span class="diff-line-text">{line.text}</span>
                                </div>
                              {/each}
                            </div>
                          {/each}
                        {:else}
                          <div class="inline-diff-empty">No line-level differences.</div>
                        {/if}
                      </div>
                    {/if}
                  {/each}
                  {#each message.deleted || [] as file}
                    <div class="change-file-row">
                      <span class="change-file deleted">− {file}</span>
                      {#if message.snapshotId}
                        <button class="change-file-diff-btn" onclick={() => toggleFileDiff(message.snapshotId, file)}>
                          {isDiffExpanded(message.snapshotId, file) ? 'Hide Diff' : 'View Diff'}
                        </button>
                      {/if}
                    </div>
                    {#if message.snapshotId && isDiffExpanded(message.snapshotId, file)}
                      {@const diffData = getDiffData(message.snapshotId, file)}
                      <div class="inline-diff">
                        <div class="inline-diff-actions">
                          <button
                            class="btn-secondary btn-sm"
                            disabled={isApplying(message.snapshotId, file, 'snapshot')}
                            onclick={() => applyFileVersion(message.snapshotId, file, 'snapshot')}
                          >
                            {isApplying(message.snapshotId, file, 'snapshot') ? 'Applying…' : 'Use Snapshot Version'}
                          </button>
                          <button
                            class="btn-ghost btn-sm"
                            disabled={isApplying(message.snapshotId, file, 'parent')}
                            onclick={() => applyFileVersion(message.snapshotId, file, 'parent')}
                          >
                            {isApplying(message.snapshotId, file, 'parent') ? 'Applying…' : 'Use Previous Version'}
                          </button>
                        </div>
                        {#if isDiffLoading(message.snapshotId, file)}
                          <div class="inline-diff-empty">Loading diff…</div>
                        {:else if diffData?.hunks?.length > 0}
                          {#each diffData.hunks as hunk}
                            <div class="diff-hunk">
                              <div class="diff-hunk-header">@@ -{hunk.oldStart} +{hunk.newStart} @@</div>
                              {#each hunk.lines as line}
                                <div class="diff-line" class:add={line.type === 'add'} class:remove={line.type === 'remove'}>
                                  <span class="diff-line-num">{line.oldLine ?? ''}</span>
                                  <span class="diff-line-num">{line.newLine ?? ''}</span>
                                  <span class="diff-line-prefix">{linePrefix(line.type)}</span>
                                  <span class="diff-line-text">{line.text}</span>
                                </div>
                              {/each}
                            </div>
                          {/each}
                        {:else}
                          <div class="inline-diff-empty">No line-level differences.</div>
                        {/if}
                      </div>
                    {/if}
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        {:else}
          <MessageBubble {message} />
        {/if}
      {/each}

      <!-- Streaming indicator -->
      {#if $streaming}
        {#if $activeTools.length > 0}
          <div class="message message-assistant">
            <div class="message-content assistant-content">
              <div class="tool-pills">
                {#each $activeTools as tool}
                  <span class="tool-pill" class:tool-running={tool.status === 'running'}>
                    {#if tool.status === 'running'}
                      <span class="spinner"></span>
                    {:else}
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path d="M2.5 6l2.5 2.5 4.5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                      </svg>
                    {/if}
                    {tool.label}
                    {#if tool.elapsedMs}
                      <span class="tool-pill-time">{Math.max(0, Math.round(tool.elapsedMs / 100) / 10)}s</span>
                    {/if}
                  </span>
                {/each}
              </div>
              {#if $streamingText}
                <div class="streaming-text">{@html formatStreamingHtml($streamingText)}</div>
              {/if}
            </div>
          </div>
        {:else if $streamingText}
          <div class="message message-assistant">
            <div class="message-content assistant-content">
              <div class="streaming-text">{@html formatStreamingHtml($streamingText)}</div>
              <span class="cursor-blink">▎</span>
            </div>
          </div>
        {:else}
          <div class="typing-indicator">
            <span></span><span></span><span></span>
          </div>
        {/if}
      {/if}
    {/if}
    {/if}
  </div>

  <!-- Input area -->
  <div class="chat-input-area">
    <div class="input-footer">
      <div class="input-footer-left">
        <ModelPicker />
        {#if $aiMode === 'cloud' && ($credits != null || $sessionCredits > 0)}
          <span class="credit-badge">
            <span class="credit-dot"></span>
            {#if $credits?.total_credits != null}{Math.round($credits.total_credits)} remaining{/if}{#if $sessionCredits > 0}{$credits?.total_credits != null ? ' · ' : ''}{Math.round($sessionCredits)} credits used{/if}
          </span>
        {:else if $sessionUsage.inputTokens > 0}
          <span class="usage-badge">
            {formatTokens($sessionUsage.inputTokens + $sessionUsage.outputTokens)} · {formatCost($sessionUsage.estimatedCost)}
          </span>
        {/if}
      </div>
      {#if $messages.length > 0}
        <button class="icon-btn" title="Clear conversation" onclick={handleClear}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>
      {/if}
    </div>

    <div class="input-wrapper">
      <MentionDropdown
        items={filteredMentions}
        visible={showMentions}
        selectedIndex={mentionSelectedIndex}
        onSelect={handleMentionSelect}
      />

      {#if selectedMentions.length > 0}
        <div class="selected-mentions">
          {#each selectedMentions as m, i}
            <span class="mention-tag">
              @{m.title || m.filename || m.id}
              <button class="mention-remove" onclick={() => selectedMentions = selectedMentions.filter((_, j) => j !== i)}>×</button>
            </span>
          {/each}
        </div>
      {/if}

      <textarea
        bind:this={inputEl}
        bind:value={inputText}
        oninput={(e) => { handleInput(e); autoResize(e.target); }}
        onkeydown={handleKeydown}
        placeholder="Describe what you want to create… (@ to mention)"
        rows="1"
        disabled={$streaming}
      ></textarea>

      <div class="input-actions">
        {#if $streaming}
          <button class="stop-btn" onclick={handleStop} title="Stop generating">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="3" y="3" width="8" height="8" rx="1" fill="currentColor"/>
            </svg>
          </button>
        {:else}
          <button class="send-btn" onclick={handleSend} disabled={!inputText.trim()} title="Send message">
            <Icon size={16} fill="white" stroke="none">
              <path d="M12 3L4 14h5.5v7h5v-7H20L12 3z"/>
            </Icon>
          </button>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .chat-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    overflow: hidden;
    background: var(--bg-primary);
    animation: chatPanelIn 260ms var(--ease);
  }

  .chat-header {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding: var(--sp-xs) var(--sp-md);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    gap: var(--sp-xs);
  }

  .new-chat-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    background: none;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text-secondary);
    font-size: var(--text-xs);
    font-weight: 500;
    cursor: pointer;
    transition: all var(--duration-fast) var(--ease);
  }

  .new-chat-btn:hover {
    background: var(--bg-secondary);
    color: var(--text-primary);
    border-color: var(--text-tertiary);
  }

  .usage-badge {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    padding: 2px 8px;
    border-radius: var(--radius-pill);
    background: var(--bg-secondary);
  }

  .credit-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--text-xs);
    color: var(--accent);
    padding: 2px 8px;
    border-radius: var(--radius-pill);
    background: var(--accent-subtle);
    font-weight: 500;
  }

  .credit-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 4px var(--accent);
  }

  .icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: var(--radius-md);
    background: none;
    border: none;
    color: var(--text-tertiary);
    cursor: pointer;
    transition: all var(--duration-fast) var(--ease);
  }

  .icon-btn:hover {
    background: var(--bg-secondary);
    color: var(--text-primary);
  }

  /* Body */
  .chat-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: var(--sp-md);
    scroll-behavior: smooth;
  }

  .course-walkthrough {
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    border-radius: var(--radius-md);
    padding: var(--sp-md);
    margin-bottom: var(--sp-md);
    box-shadow: var(--shadow-sm);
  }

  .walkthrough-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--sp-sm);
    margin-bottom: var(--sp-sm);
  }

  .walkthrough-kicker {
    font-size: 10px;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 700;
  }

  .walkthrough-title {
    margin: 4px 0 0;
    font-size: var(--text-sm);
    color: var(--text-primary);
    font-weight: 600;
  }

  .walkthrough-dismiss {
    border: none;
    background: none;
    color: var(--text-tertiary);
    font-size: var(--text-base);
    line-height: 1;
    cursor: pointer;
    padding: 0;
  }

  .walkthrough-dismiss:hover {
    color: var(--text-primary);
  }

  .walkthrough-steps {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: var(--sp-sm);
  }

  .walkthrough-step {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }

  .walkthrough-step.done {
    color: var(--success);
  }

  .walkthrough-dot {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 1px solid currentColor;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-weight: 700;
  }

  .walkthrough-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-xs);
  }

  .execution-plan {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: var(--sp-sm) var(--sp-md);
    margin-bottom: var(--sp-md);
  }

  .execution-plan-title {
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--text-secondary);
    margin-bottom: 6px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .execution-steps {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .execution-step {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--text-tertiary);
    font-size: var(--text-xs);
  }

  .execution-step.active {
    color: var(--accent);
  }

  .execution-step.done {
    color: var(--success);
  }

  .execution-step:global(.error),
  .execution-step.error {
    color: var(--error);
  }

  .execution-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.85;
  }

  /* Empty state */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: var(--sp-2xl);
    height: 100%;
    gap: var(--sp-md);
    color: var(--text-secondary);
  }

  .empty-state.compact {
    padding: 0;
    min-height: 0;
    height: auto;
    width: 100%;
    gap: var(--sp-xs);
    justify-content: flex-start;
    align-items: flex-start;
    text-align: left;
  }

  .empty-state.compact .empty-icon {
    display: none;
  }

  .empty-state.compact p {
    max-width: min(100%, 560px);
  }

  .empty-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 64px;
    height: 64px;
    border-radius: 50%;
    background: var(--accent-subtle);
    color: var(--accent);
    margin-bottom: var(--sp-sm);
  }

  .empty-state h3 {
    margin: 0;
    font-size: var(--text-lg);
    color: var(--text-primary);
  }

  .empty-state p {
    margin: 0;
    max-width: 320px;
    font-size: var(--text-sm);
    line-height: 1.6;
  }

  .quick-actions {
    display: flex;
    flex-direction: column;
    gap: var(--sp-sm);
    margin-top: var(--sp-md);
    width: 100%;
    max-width: 280px;
  }

  .empty-state.compact .quick-actions {
    width: min(100%, 320px);
    max-width: min(100%, 320px);
    margin-top: 2px;
  }

  .quick-btn {
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
    padding: var(--sp-sm) var(--sp-md);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text-secondary);
    font-size: var(--text-sm);
    cursor: pointer;
    transition: all var(--duration-fast) var(--ease);
    text-align: left;
  }

  .quick-btn:hover {
    background: var(--accent-subtle);
    border-color: var(--accent);
    color: var(--text-primary);
    box-shadow: var(--shadow-sm);
  }

  .quick-btn:active:not(:disabled) {
    transform: scale(0.99);
  }

  .quick-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .quick-btn:disabled:hover {
    background: var(--bg-elevated);
    border-color: var(--border);
    color: var(--text-secondary);
  }

  .quick-btn.workflow {
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
  }

  .quick-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-weight: 500;
  }

  .quick-desc {
    font-size: 11px;
    color: var(--text-tertiary);
    font-weight: 400;
  }

  /* Workflow progress */
  .workflow-progress {
    margin: 16px 20px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
    animation: workflowIn 220ms var(--ease);
  }

  .workflow-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
  }

  .workflow-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .workflow-steps {
    padding: 8px 14px;
    max-height: 200px;
    overflow-y: auto;
  }

  .workflow-step {
    font-size: 12px;
    color: var(--text-secondary);
    padding: 3px 0;
    line-height: 1.4;
  }

  .workflow-step.active {
    color: var(--accent);
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .workflow-step.error {
    color: var(--error);
    font-weight: 500;
  }

  .workflow-spinner {
    width: 10px;
    height: 10px;
    border: 2px solid var(--accent);
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
    flex-shrink: 0;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* Streaming / typing */
  .message {
    display: flex;
    margin-bottom: var(--sp-md);
  }

  .message-assistant {
    justify-content: flex-start;
  }

  .message-content {
    max-width: 85%;
    padding: var(--sp-md);
    border-radius: var(--radius-lg);
    line-height: 1.6;
    font-size: var(--text-base);
  }

  .assistant-content {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-bottom-left-radius: var(--radius-sm);
  }

  .streaming-text {
    white-space: pre-wrap;
    word-break: break-word;
  }

  .cursor-blink {
    animation: blink 0.8s infinite;
    color: var(--accent);
  }

  @keyframes blink {
    0%, 50% { opacity: 1; }
    51%, 100% { opacity: 0; }
  }

  .tool-pills {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-xs);
    margin-bottom: var(--sp-sm);
  }

  .tool-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 10px;
    border-radius: var(--radius-pill);
    background: var(--bg-secondary);
    color: var(--text-secondary);
    font-size: var(--text-xs);
    font-weight: 500;
  }

  .tool-pill-time {
    opacity: 0.72;
    font-size: 10px;
  }

  .tool-running {
    background: var(--accent-subtle);
    color: var(--accent);
  }

  .spinner {
    width: 10px;
    height: 10px;
    border: 2px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .typing-indicator {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: var(--sp-sm) var(--sp-md);
    margin-bottom: var(--sp-md);
  }

  .typing-indicator span {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-tertiary);
    animation: typing 1.2s infinite;
  }

  .typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
  .typing-indicator span:nth-child(3) { animation-delay: 0.4s; }

  .chat-loading-state {
    min-height: 88px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--sp-md);
  }

  @keyframes typing {
    0%, 80%, 100% { transform: translateY(0); }
    40% { transform: translateY(-6px); }
  }

  /* Input */
  .chat-input-area {
    border-top: 1px solid var(--border);
    padding: var(--sp-sm) var(--sp-md) var(--sp-md);
    background: var(--bg-elevated);
    flex-shrink: 0;
  }

  .input-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 0 var(--sp-sm);
  }

  .input-footer-left {
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
  }

  .input-wrapper {
    position: relative;
    display: flex;
    flex-direction: column;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    transition: border-color var(--duration-fast) var(--ease), box-shadow var(--duration-fast) var(--ease), transform var(--duration-fast) var(--ease);
  }

  .input-wrapper:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-subtle);
  }

  .selected-mentions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-xs);
    padding: var(--sp-sm) var(--sp-sm) 0;
  }

  .mention-tag {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 2px 8px;
    border-radius: var(--radius-pill);
    background: var(--accent-subtle);
    color: var(--accent);
    font-size: var(--text-xs);
    font-weight: 500;
  }

  .mention-remove {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    border: none;
    background: none;
    color: currentColor;
    cursor: pointer;
    font-size: 12px;
    padding: 0;
    opacity: 0.6;
  }

  .mention-remove:hover {
    opacity: 1;
  }

  textarea {
    width: 100%;
    padding: var(--sp-sm) var(--sp-md);
    background: transparent;
    border: none;
    box-shadow: none;
    outline: none;
    color: var(--text-primary);
    font-family: inherit;
    font-size: var(--text-sm);
    line-height: 1.5;
    resize: none;
    min-height: 36px;
    max-height: 150px;
  }

  .input-wrapper textarea:focus {
    border: none;
    box-shadow: none;
    outline: none;
  }

  textarea::placeholder {
    color: var(--text-tertiary);
  }

  textarea:disabled {
    opacity: 0.6;
  }

  .input-actions {
    display: flex;
    justify-content: flex-end;
    padding: 0 var(--sp-sm) var(--sp-sm);
  }

  .send-btn, .stop-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: none;
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: all var(--duration-fast) var(--ease);
  }

  .send-btn {
    background: var(--palette-blue);
    color: white;
  }

  .send-btn:hover:not(:disabled) {
    filter: brightness(1.1);
  }

  .send-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .stop-btn {
    background: var(--error);
    color: white;
  }

  .stop-btn:hover {
    filter: brightness(1.1);
  }

  .send-btn:active:not(:disabled),
  .stop-btn:active:not(:disabled) {
    transform: scale(0.96);
  }

  /* Change Summary Card */
  .change-summary-card {
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
    margin: var(--sp-sm) 0;
    padding: var(--sp-sm) var(--sp-md);
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    font-size: var(--text-xs);
  }

  .change-summary-icon {
    flex-shrink: 0;
    color: var(--text-secondary);
  }

  .change-summary-body {
    display: flex;
    flex-direction: column;
    gap: 1px;
    flex: 1;
    min-width: 0;
  }

  .change-summary-title {
    font-weight: 600;
    color: var(--text-primary);
  }

  .change-summary-detail {
    color: var(--text-tertiary);
    font-size: var(--text-xs);
  }

  .change-summary-actions {
    display: flex;
    gap: var(--sp-xs);
    margin-top: 6px;
  }

  .change-files {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-top: 6px;
  }

  .change-file {
    font-family: var(--font-mono);
    font-size: 11px;
    border: none;
    background: none;
    padding: 2px 0;
    text-align: left;
    color: var(--text-secondary);
  }

  button.change-file {
    cursor: pointer;
  }

  button.change-file:hover {
    text-decoration: underline;
  }

  .change-file.added { color: var(--success); }
  .change-file.modified { color: var(--warning); }
  .change-file.deleted { color: var(--error); }

  .change-file-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-sm);
  }

  .change-file-diff-btn {
    border: 1px solid var(--border);
    background: var(--bg-secondary);
    color: var(--text-secondary);
    border-radius: var(--radius-sm);
    font-size: 10px;
    padding: 1px 6px;
    cursor: pointer;
    white-space: nowrap;
  }

  .change-file-diff-btn:hover {
    color: var(--text-primary);
    border-color: var(--text-tertiary);
  }

  .inline-diff {
    margin: 4px 0 8px 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-primary);
    overflow: hidden;
  }

  .inline-diff-actions {
    display: flex;
    gap: var(--sp-xs);
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-elevated);
  }

  .inline-diff-empty {
    padding: 8px;
    font-size: 11px;
    color: var(--text-tertiary);
  }

  .diff-hunk {
    border-top: 1px solid var(--border);
  }

  .diff-hunk:first-child {
    border-top: none;
  }

  .diff-hunk-header {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-tertiary);
    background: var(--bg-secondary);
    padding: 4px 8px;
  }

  .diff-line {
    display: grid;
    grid-template-columns: 40px 40px 14px 1fr;
    gap: 6px;
    align-items: start;
    font-family: var(--font-mono);
    font-size: 10px;
    line-height: 1.35;
    padding: 1px 8px;
  }

  .diff-line.add {
    background: color-mix(in srgb, var(--success) 12%, transparent);
  }

  .diff-line.remove {
    background: color-mix(in srgb, var(--error) 10%, transparent);
  }

  .diff-line-num {
    color: var(--text-tertiary);
    text-align: right;
  }

  .diff-line-prefix {
    color: var(--text-secondary);
    text-align: center;
  }

  .diff-line-text {
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-word;
  }

  @keyframes chatPanelIn {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  @keyframes workflowIn {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }

  @media (max-width: 760px) {
    .chat-body {
      padding: var(--sp-sm);
    }

    .empty-state {
      padding: var(--sp-xl) var(--sp-md);
    }

    .quick-actions {
      max-width: none;
    }

    .walkthrough-actions {
      flex-direction: column;
    }

    .walkthrough-actions :global(button) {
      width: 100%;
      justify-content: center;
    }

    .message-content {
      max-width: 100%;
    }

    .chat-input-area {
      padding: var(--sp-sm);
    }

    .input-footer {
      gap: var(--sp-xs);
      align-items: flex-start;
    }

    .input-footer-left {
      flex-wrap: wrap;
      min-width: 0;
    }
  }

  @media (max-height: 820px) {
    .chat-body {
      padding: var(--sp-sm);
    }

    .course-walkthrough {
      padding: var(--sp-sm);
      margin-bottom: var(--sp-sm);
    }

    .walkthrough-steps {
      gap: 4px;
      margin-bottom: 6px;
    }

    .walkthrough-actions {
      gap: 6px;
    }

    .empty-state {
      padding: var(--sp-lg) var(--sp-md);
      justify-content: flex-start;
      align-items: flex-start;
      text-align: left;
    }

    .empty-state h3 {
      font-size: var(--text-base);
    }

    .empty-state p {
      max-width: min(100%, 560px);
      font-size: var(--text-xs);
      line-height: 1.5;
    }

    .quick-actions {
      margin-top: var(--sp-sm);
      max-width: min(100%, 360px);
    }

    .workflow-progress {
      margin: 12px 0 0;
    }
  }

  @media (max-height: 700px) {
    .walkthrough-title {
      font-size: var(--text-xs);
    }

    .walkthrough-step {
      font-size: 11px;
    }

    .empty-state {
      gap: var(--sp-sm);
      padding-top: var(--sp-sm);
    }

    .empty-state.compact {
      gap: 4px;
    }

    .quick-btn {
      padding: 8px 10px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .chat-panel,
    .workflow-progress,
    .typing-indicator span,
    .cursor-blink,
    .workflow-spinner,
    .spinner {
      animation: none;
    }

    .quick-btn:hover,
    .quick-btn:active:not(:disabled),
    .input-wrapper:focus-within,
    .send-btn:hover:not(:disabled),
    .stop-btn:hover,
    .send-btn:active:not(:disabled),
    .stop-btn:active:not(:disabled) {
      transform: none;
    }
  }
</style>
