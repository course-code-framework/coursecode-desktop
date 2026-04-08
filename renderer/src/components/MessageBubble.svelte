<script>
  import { marked } from 'marked';

  let { message } = $props();

  let isUser = $derived(message.role === 'user');
  let isError = $derived(message.isError);

  // Configure marked for safe rendering (no code blocks for user-facing AI)
  marked.setOptions({
    breaks: true,
    gfm: true
  });

  function renderMarkdown(text) {
    if (!text) return '';
    return sanitizeRenderedHtml(marked.parse(text));
  }

  function sanitizeRenderedHtml(html) {
    const template = document.createElement('template');
    template.innerHTML = html;

    template.content.querySelectorAll('script,style,iframe,object,embed,link,meta').forEach(node => node.remove());

    for (const el of template.content.querySelectorAll('*')) {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        const value = (attr.value || '').trim();
        if (name.startsWith('on')) {
          el.removeAttribute(attr.name);
          continue;
        }
        if ((name === 'href' || name === 'src') && /^javascript:/i.test(value)) {
          el.removeAttribute(attr.name);
        }
      }
    }

    return template.innerHTML;
  }

  function handleMarkdownClick(event) {
    const anchor = event.target?.closest('a');
    if (!anchor) return;

    const href = anchor.getAttribute('href') || '';
    const isExternal = /^https?:\/\//i.test(href);
    if (isExternal) return;

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
</script>

<div class="message" class:message-user={isUser} class:message-assistant={!isUser} class:message-error={isError}>
  {#if isUser}
    <div class="message-content user-content">
      {#if message.mentions?.length}
        <div class="mention-chips">
          {#each message.mentions as mention}
            <span class="mention-chip">@{mention.title || mention.filename || mention.id}</span>
          {/each}
        </div>
      {/if}
      <p>{message.content}</p>
    </div>
  {:else}
    <div class="message-content assistant-content" class:error-content={isError}>
      {#if message.toolCalls?.length}
        <div class="tool-pills">
          {#each message.toolCalls as tc}
            {#if tc.filePath}
              <button
                class="tool-pill tool-pill-clickable"
                class:tool-done={tc.status === 'done'}
                class:tool-error={tc.status === 'error'}
                onclick={() => {
                  const event = new CustomEvent('openfile', { detail: { path: tc.filePath }, bubbles: true });
                  document.dispatchEvent(event);
                }}
                title={`Open ${tc.filePath}`}
              >
                {#if tc.status === 'done'}
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M2.5 6l2.5 2.5 4.5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                {/if}
                <span>{tc.label}</span>
                {#if tc.elapsedMs}
                  <span class="tool-meta">{formatElapsed(tc.elapsedMs)}</span>
                {/if}
              </button>
            {:else}
              <span class="tool-pill" class:tool-done={tc.status === 'done'} class:tool-error={tc.status === 'error'}>
                {#if tc.status === 'done'}
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M2.5 6l2.5 2.5 4.5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                {/if}
                <span>{tc.label}</span>
                {#if tc.elapsedMs}
                  <span class="tool-meta">{formatElapsed(tc.elapsedMs)}</span>
                {/if}
              </span>
            {/if}
          {/each}
        </div>
        {#if message.toolCalls.some(tc => tc.reason)}
          <div class="tool-reasons">
            {#each message.toolCalls as tc}
              {#if tc.reason}
                <span class="tool-reason">• {tc.reason}</span>
              {/if}
            {/each}
          </div>
        {/if}
      {/if}

      {#if isError}
        <div class="error-icon">⚠️</div>
      {/if}

      <div class="markdown-body" onclick={handleMarkdownClick}>
        {@html renderMarkdown(message.content)}
      </div>

      {#if message.screenshots?.length}
        <div class="screenshots">
          {#each message.screenshots as screenshot}
            <button type="button" class="screenshot-btn" onclick={() => window.open(`data:image/webp;base64,${screenshot}`)}>
              <img
                class="screenshot"
                src={`data:image/webp;base64,${screenshot}`}
                alt="Course preview"
              />
            </button>
          {/each}
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

  /* Tool use pills */
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

  .tool-meta {
    opacity: 0.75;
    font-weight: 500;
  }

  .tool-done {
    background: var(--success-subtle);
    color: var(--success);
  }

  .tool-error {
    background: var(--error-subtle);
    color: var(--error);
  }

  .tool-pill-clickable {
    cursor: pointer;
    transition: all var(--duration-fast) var(--ease);
  }

  .tool-pill-clickable:hover {
    text-decoration: underline;
    filter: brightness(0.9);
  }

  .tool-reasons {
    margin-top: 2px;
    margin-bottom: var(--sp-sm);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .tool-reason {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    line-height: 1.4;
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

  /* Usage info */
  .usage-line {
    margin-top: var(--sp-sm);
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }
</style>
