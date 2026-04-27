<script>
  import { marked } from 'marked';

  let { message } = $props();

  let isUser = $derived(message.role === 'user');
  let isError = $derived(message.isError);

  // Tool activity disclosure state
  let toolsExpanded = $state(false);
  let filesExpanded = $state(false);
  let toolCount = $derived(message.toolCalls?.length || 0);
  let toolsAllDone = $derived(message.toolCalls?.every(tc => tc.status === 'done') ?? true);
  let toolErrors = $derived(message.toolCalls?.filter(tc => tc.status === 'error').length || 0);
  let totalToolTime = $derived.by(() => {
    const total = (message.toolCalls || []).reduce((sum, tc) => sum + (tc.elapsedMs || 0), 0);
    if (total < 1000) return total > 0 ? `${total}ms` : '';
    return `${(total / 1000).toFixed(1)}s`;
  });
  let filesChanged = $derived.by(() => {
    const paths = new Set();
    for (const tc of message.toolCalls || []) {
      if (tc.filePath) paths.add(tc.filePath);
    }
    return paths.size;
  });

  // Extract file mutations for the prominent file changes list
  let fileChanges = $derived.by(() => {
    const map = new Map();
    for (const tc of message.toolCalls || []) {
      if (!tc.filePath) continue;
      const isMutation = tc.tool === 'edit_file' || tc.tool === 'create_file';
      if (!isMutation) continue;
      const existing = map.get(tc.filePath);
      if (existing) {
        existing.editCount += 1;
        if (tc.status === 'error') existing.hasError = true;
      } else {
        map.set(tc.filePath, {
          path: tc.filePath,
          type: tc.tool === 'create_file' ? 'created' : 'edited',
          editCount: 1,
          hasError: tc.status === 'error'
        });
      }
    }
    return [...map.values()];
  });

  // Configure marked for safe rendering (no code blocks for user-facing AI)
  marked.setOptions({
    breaks: true,
    gfm: true
  });

  function renderMarkdown(text) {
    if (!text) return '';
    let html = sanitizeRenderedHtml(marked.parse(text));
    // Wrap code blocks with a container that includes a copy button
    html = html.replace(
      /<pre><code(?:\s+class="language-(\w+)")?>([\s\S]*?)<\/code><\/pre>/g,
      (_, lang, code) => {
        const langLabel = lang ? `<span class="code-lang">${lang}</span>` : '';
        return `<div class="code-block-wrapper">${langLabel}<button class="code-copy-btn" title="Copy code">Copy</button><pre><code${lang ? ` class="language-${lang}"` : ''}>${code}</code></pre></div>`;
      }
    );
    return html;
  }

  function sanitizeRenderedHtml(html) {
    const template = document.createElement('template');
    template.innerHTML = html;

    template.content.querySelectorAll('script,style,iframe,object,embed,link,meta,img').forEach(node => node.remove());

    const allowedTags = new Set(['p', 'br', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'a']);

    for (const el of template.content.querySelectorAll('*')) {
      const tag = el.tagName.toLowerCase();
      if (!allowedTags.has(tag)) {
        const text = document.createTextNode(el.textContent || '');
        el.replaceWith(text);
        continue;
      }

      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        const value = (attr.value || '').trim();
        if (name.startsWith('on') || name === 'style' || name === 'srcset') {
          el.removeAttribute(attr.name);
          continue;
        }

        if (tag === 'a' && name === 'href') {
          const isHttp = /^https?:\/\//i.test(value);
          const isRelativePath = /^(\.?\.\/|[^:\s]+\/[^\s]*|[^:\s]+$)/.test(value) && !/^[a-z]+:/i.test(value);
          if (!isHttp && !isRelativePath) {
            el.removeAttribute(attr.name);
          }
          continue;
        }

        if (tag === 'a' && name === 'title') {
          continue;
        }

        el.removeAttribute(attr.name);
      }
    }

    return template.innerHTML;
  }

  function handleMarkdownClick(event) {
    // Handle copy button clicks on code blocks
    const copyBtn = event.target?.closest('.code-copy-btn');
    if (copyBtn) {
      event.preventDefault();
      const wrapper = copyBtn.closest('.code-block-wrapper');
      const codeEl = wrapper?.querySelector('code');
      if (codeEl) {
        try {
          window.api.clipboard.writeText(codeEl.textContent || '');
          copyBtn.textContent = 'Copied!';
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
        } catch {
          copyBtn.textContent = 'Failed';
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
        }
      }
      return;
    }

    const anchor = event.target?.closest('a');
    if (!anchor) return;

    const href = anchor.getAttribute('href') || '';
    const isExternal = /^https?:\/\//i.test(href);
    if (isExternal) {
      event.preventDefault();
      window.api.shell.openExternal(href);
      return;
    }

    if (!href || href.startsWith('#')) return;

    event.preventDefault();
    const normalized = href
      .replace(/^\.\//, '')
      .replace(/^\//, '')
      .replace(/\\/g, '/');
    const openFileEvent = new CustomEvent('openfile', {
      detail: { path: normalized },
      bubbles: true
    });
    document.dispatchEvent(openFileEvent);
  }

  function formatUsage(usage) {
    if (!usage) return '';
    if (usage.creditsCharged != null) {
      return `${Math.round(usage.creditsCharged)} credits used`;
    }
    const count = (usage.inputTokens || 0) + (usage.outputTokens || 0);
    if (!count) return '';
    if (count < 1000) return `${count} tokens`;
    return `${(count / 1000).toFixed(1)}k tokens`;
  }

  function formatElapsed(ms) {
    if (!ms || ms <= 0) return '';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  function fileName(path) {
    return path?.split('/').pop() || path;
  }

  function dirPath(path) {
    const parts = (path || '').split('/');
    return parts.length > 1 ? parts.slice(0, -1).join('/') + '/' : '';
  }

  function openFileInEditor(path) {
    const event = new CustomEvent('openfile', { detail: { path }, bubbles: true });
    document.dispatchEvent(event);
  }

  let lightboxSrc = $state(null);

  function openLightbox(base64) {
    lightboxSrc = `data:image/webp;base64,${base64}`;
  }

  function closeLightbox(e) {
    if (e.type === 'keydown' && e.key !== 'Escape') return;
    lightboxSrc = null;
  }

  function handleWindowKeydown(e) {
    if (lightboxSrc) closeLightbox(e);
  }
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<div class="message" class:message-user={isUser} class:message-assistant={!isUser} class:message-error={isError}>
  {#if isUser}
    <div class="message-content user-content">
      {#if message.mentions?.length}
        <div class="mention-chips">
          {#each message.mentions as mention}
            <span class="mention-chip">@{mention.type === 'slide' ? (mention.file || mention.id) : (mention.title || mention.filename || mention.id)}</span>
          {/each}
        </div>
      {/if}
      <p>{message.content}</p>
    </div>
  {:else}
    <div class="message-content assistant-content" class:error-content={isError}>
      {#if message.toolCalls?.length}
        <div class="tool-activity">
          <button class="tool-activity-summary" onclick={() => toolsExpanded = !toolsExpanded}>
            <span class="tool-activity-chevron" class:expanded={toolsExpanded}>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M3.5 2L6.5 5L3.5 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </span>
            {#if toolErrors > 0}
              <span class="tool-activity-icon tool-activity-error">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1.2"/>
                  <path d="M4 4l4 4M8 4l-4 4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
                </svg>
              </span>
            {:else if toolsAllDone}
              <span class="tool-activity-icon tool-activity-done">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M2.5 6l2.5 2.5 4.5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </span>
            {/if}
            <span class="tool-activity-label">
              Used {toolCount} tool{toolCount !== 1 ? 's' : ''}
              {#if filesChanged > 0}
                · {filesChanged} file{filesChanged !== 1 ? 's' : ''}
              {/if}
              {#if totalToolTime}
                · {totalToolTime}
              {/if}
              {#if toolErrors > 0}
                · {toolErrors} error{toolErrors !== 1 ? 's' : ''}
              {/if}
            </span>
          </button>
          {#if toolsExpanded}
            <div class="tool-activity-details">
              {#each message.toolCalls as tc}
                {#if tc.filePath}
                  <button
                    class="tool-detail-row tool-detail-clickable"
                    class:tool-done={tc.status === 'done'}
                    class:tool-error={tc.status === 'error'}
                    onclick={() => openFileInEditor(tc.filePath)}
                    title={`Open ${tc.filePath}`}
                  >
                    <span class="tool-detail-status">
                      {#if tc.status === 'done'}
                        <svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M2.5 6l2.5 2.5 4.5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                      {:else if tc.status === 'error'}
                        <svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
                      {/if}
                    </span>
                    <span class="tool-detail-label">{tc.label}</span>
                    {#if tc.elapsedMs}<span class="tool-detail-time">{formatElapsed(tc.elapsedMs)}</span>{/if}
                  </button>
                {:else}
                  <div class="tool-detail-row" class:tool-done={tc.status === 'done'} class:tool-error={tc.status === 'error'}>
                    <span class="tool-detail-status">
                      {#if tc.status === 'done'}
                        <svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M2.5 6l2.5 2.5 4.5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                      {:else if tc.status === 'error'}
                        <svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
                      {/if}
                    </span>
                    <span class="tool-detail-label">{tc.label}</span>
                    {#if tc.elapsedMs}<span class="tool-detail-time">{formatElapsed(tc.elapsedMs)}</span>{/if}
                  </div>
                {/if}
                {#if tc.reason}
                  <div class="tool-detail-reason">{tc.reason}</div>
                {/if}
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      {#if isError}
        <div class="error-icon">⚠️</div>
      {/if}

      <div class="markdown-body" role="presentation" onclick={handleMarkdownClick}>
        {@html renderMarkdown(message.content)}
      </div>

      {#if message.screenshots?.length}
        <div class="screenshots">
          {#each message.screenshots as screenshot}
            <button type="button" class="screenshot-btn" onclick={() => openLightbox(screenshot)}>
              <img
                class="screenshot"
                src={`data:image/webp;base64,${screenshot}`}
                alt="Course preview"
              />
            </button>
          {/each}
        </div>
      {/if}

      {#if lightboxSrc}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div class="lightbox-overlay" onclick={closeLightbox}>
          <img src={lightboxSrc} alt="Screenshot preview" class="lightbox-img" />
        </div>
      {/if}

      {#if fileChanges.length > 0}
        <div class="file-changes-footer">
          <button class="file-changes-summary" onclick={() => filesExpanded = !filesExpanded}>
            <span class="file-changes-chevron" class:expanded={filesExpanded}>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M3.5 2L6.5 5L3.5 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </span>
            <span class="file-changes-icon">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path d="M4 20h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-9l-5 5v9a2 2 0 0 0 2 2Z" stroke="currentColor" stroke-width="1.3"/>
                <path d="M14 4v5h-5" stroke="currentColor" stroke-width="1.3"/>
              </svg>
            </span>
            <span class="file-changes-label">
              {fileChanges.length} file{fileChanges.length !== 1 ? 's' : ''} changed
            </span>

          </button>
          {#if filesExpanded}
            <div class="file-changes-details">
              {#each fileChanges as fc}
                <button class="file-change-row" onclick={() => openFileInEditor(fc.path)} title={fc.path}>
                  <span class="file-change-icon" class:created={fc.type === 'created'} class:edited={fc.type === 'edited'} class:errored={fc.hasError}>
                    {#if fc.type === 'created'}
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                        <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                      </svg>
                    {:else}
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                        <path d="M11.5 1.5l3 3-9 9H2.5v-3l9-9z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
                      </svg>
                    {/if}
                  </span>
                  <span class="file-change-name">{fileName(fc.path)}</span>
                  <span class="file-change-dir">{dirPath(fc.path)}</span>
                  {#if fc.editCount > 1}
                    <span class="file-change-badge">{fc.editCount} edits</span>
                  {/if}
                  {#if fc.type === 'created'}
                    <span class="file-change-badge created">new</span>
                  {/if}
                  {#if fc.hasError}
                    <span class="file-change-badge errored">error</span>
                  {/if}
                </button>
              {/each}

            </div>
          {/if}
        </div>
      {/if}

      {#if message.usage}
        <div class="usage-line">
          {formatUsage(message.usage)}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .message {
    display: flex;
    margin-bottom: var(--sp-md);
    animation: fadeIn 0.2s var(--ease);
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .message-user {
    justify-content: flex-end;
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

  .user-content {
    background: var(--accent);
    color: var(--text-on-accent);
    border-bottom-right-radius: var(--radius-sm);
  }

  .user-content p {
    margin: 0;
    white-space: pre-wrap;
  }

  .assistant-content {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-bottom-left-radius: var(--radius-sm);
  }

  .error-content {
    border-color: var(--error);
    background: var(--error-subtle);
  }

  .error-icon {
    margin-bottom: var(--sp-sm);
  }

  /* Markdown body styles */
  .markdown-body :global(p) {
    margin: 0 0 var(--sp-sm);
  }

  .markdown-body :global(p:last-child) {
    margin-bottom: 0;
  }

  .markdown-body :global(ul),
  .markdown-body :global(ol) {
    margin: var(--sp-sm) 0;
    padding-left: var(--sp-lg);
  }

  .markdown-body :global(li) {
    margin-bottom: var(--sp-xs);
  }

  .markdown-body :global(strong) {
    font-weight: 600;
  }

  .markdown-body :global(h1),
  .markdown-body :global(h2),
  .markdown-body :global(h3) {
    margin: var(--sp-md) 0 var(--sp-sm);
    font-weight: 600;
  }

  .markdown-body :global(h1) { font-size: var(--text-lg); }
  .markdown-body :global(h2) { font-size: var(--text-base); }
  .markdown-body :global(h3) { font-size: var(--text-sm); }

  /* Code block wrapper with copy button */
  .markdown-body :global(.code-block-wrapper) {
    position: relative;
    margin: var(--sp-sm) 0;
  }

  .markdown-body :global(.code-block-wrapper pre) {
    margin: 0;
    background: var(--bg-secondary);
    border-radius: var(--radius-md);
    padding: var(--sp-md);
    overflow-x: auto;
    font-size: var(--text-sm);
  }

  .markdown-body :global(.code-block-wrapper code) {
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
    font-size: var(--text-xs);
    line-height: 1.5;
  }

  .markdown-body :global(.code-copy-btn) {
    position: absolute;
    top: 6px;
    right: 6px;
    padding: 2px 8px;
    font-size: var(--text-xs);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    cursor: pointer;
    opacity: 0;
    transition: opacity var(--duration-fast) var(--ease);
    z-index: 1;
  }

  .markdown-body :global(.code-block-wrapper:hover .code-copy-btn) {
    opacity: 1;
  }

  .markdown-body :global(.code-copy-btn:hover) {
    background: var(--bg-secondary);
    color: var(--text-primary);
  }

  .markdown-body :global(.code-lang) {
    position: absolute;
    top: 6px;
    left: 10px;
    font-size: 10px;
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    pointer-events: none;
  }

  .markdown-body :global(pre) {
    background: var(--bg-secondary);
    border-radius: var(--radius-md);
    padding: var(--sp-sm) var(--sp-md);
    overflow-x: auto;
    font-size: var(--text-sm);
  }

  .markdown-body :global(code) {
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
    font-size: 0.9em;
    background: var(--bg-secondary);
    padding: 1px 4px;
    border-radius: 3px;
  }

  .markdown-body :global(pre code) {
    background: none;
    padding: 0;
  }

  /* Mention chips in user messages */
  .mention-chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-xs);
    margin-bottom: var(--sp-sm);
  }

  .mention-chip {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: var(--radius-pill);
    background: rgba(255, 255, 255, 0.2);
    font-size: var(--text-xs);
    font-weight: 500;
  }

  /* Tool activity disclosure */
  .tool-activity {
    margin-bottom: var(--sp-sm);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
    background: var(--bg-secondary);
  }

  .tool-activity-summary {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 10px;
    background: none;
    border: none;
    cursor: pointer;
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--text-secondary);
    transition: background var(--duration-fast) var(--ease);
  }

  .tool-activity-summary:hover {
    background: var(--bg-tertiary);
  }

  .tool-activity-chevron {
    display: flex;
    align-items: center;
    transition: transform var(--duration-fast) var(--ease);
    color: var(--text-tertiary);
    flex-shrink: 0;
  }

  .tool-activity-chevron.expanded {
    transform: rotate(90deg);
  }

  .tool-activity-icon {
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }

  .tool-activity-done {
    color: var(--success);
  }

  .tool-activity-error {
    color: var(--error);
  }

  .tool-activity-label {
    color: var(--text-secondary);
  }

  .tool-activity-details {
    border-top: 1px solid var(--border);
    padding: 4px 0;
    max-height: 240px;
    overflow-y: auto;
  }

  .tool-detail-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px 3px 28px;
    font-size: 11px;
    color: var(--text-secondary);
    line-height: 1.4;
  }

  .tool-detail-clickable {
    width: 100%;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
  }

  .tool-detail-clickable:hover {
    background: var(--bg-tertiary);
    text-decoration: underline;
  }

  .tool-detail-status {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    width: 12px;
  }

  .tool-detail-row.tool-done .tool-detail-status {
    color: var(--success);
  }

  .tool-detail-row.tool-error .tool-detail-status {
    color: var(--error);
  }

  .tool-detail-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tool-detail-time {
    font-size: 10px;
    color: var(--text-tertiary);
    flex-shrink: 0;
  }

  .tool-detail-reason {
    padding: 0 10px 2px 46px;
    font-size: 10px;
    color: var(--text-tertiary);
    line-height: 1.3;
  }

  /* File changes footer — collapsible, after markdown */
  .file-changes-footer {
    margin-top: var(--sp-sm);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
    background: var(--bg-secondary);
  }

  .file-changes-summary {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 10px;
    background: none;
    border: none;
    cursor: pointer;
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--text-secondary);
    transition: background var(--duration-fast) var(--ease);
  }

  .file-changes-summary:hover {
    background: var(--bg-tertiary);
  }

  .file-changes-chevron {
    display: flex;
    align-items: center;
    transition: transform var(--duration-fast) var(--ease);
    color: var(--text-tertiary);
    flex-shrink: 0;
  }

  .file-changes-chevron.expanded {
    transform: rotate(90deg);
  }

  .file-changes-icon {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    color: var(--success);
  }

  .file-changes-label {
    color: var(--text-secondary);
  }

  .file-changes-details {
    border-top: 1px solid var(--border);
    padding: 4px 0;
  }

  .file-change-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: var(--bg-secondary);
    border: none;
    cursor: pointer;
    font-size: var(--text-xs);
    color: var(--text-primary);
    text-align: left;
    width: 100%;
    transition: background var(--duration-fast) var(--ease);
  }

  .file-change-row:hover {
    background: var(--bg-tertiary);
  }

  .file-change-icon {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    justify-content: center;
    border-radius: 3px;
  }

  .file-change-icon.edited {
    color: var(--warning, #e5a100);
  }

  .file-change-icon.created {
    color: var(--success);
  }

  .file-change-icon.errored {
    color: var(--error);
  }

  .file-change-name {
    font-weight: 600;
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
    font-size: 11px;
    white-space: nowrap;
  }

  .file-change-dir {
    color: var(--text-tertiary);
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
    font-size: 10px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
  }

  .file-change-badge {
    font-size: 10px;
    font-weight: 500;
    padding: 1px 6px;
    border-radius: var(--radius-pill);
    background: var(--bg-primary);
    color: var(--text-tertiary);
    flex-shrink: 0;
  }

  .file-change-badge.created {
    color: var(--success);
    background: var(--success-subtle);
  }

  .file-change-badge.errored {
    color: var(--error);
    background: var(--error-subtle);
  }

  /* Screenshots */
  .screenshots {
    display: flex;
    flex-direction: column;
    gap: var(--sp-sm);
    margin-top: var(--sp-sm);
  }

  .screenshot-btn {
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
  }

  .screenshot {
    width: 100%;
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
    cursor: pointer;
    transition: box-shadow var(--duration-fast) var(--ease);
  }

  .screenshot:hover {
    box-shadow: var(--shadow-md);
  }

  /* Lightbox overlay */
  .lightbox-overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.8);
    cursor: zoom-out;
    animation: fadeIn 0.15s var(--ease);
  }

  .lightbox-img {
    max-width: 90vw;
    max-height: 90vh;
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
    object-fit: contain;
  }

  /* Usage info */
  .usage-line {
    margin-top: var(--sp-sm);
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }
</style>
