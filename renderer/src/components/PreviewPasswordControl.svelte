<script>
  import { generatePreviewPassword } from '../lib/preview-password.js';

  let {
    id = 'preview-password',
    requirePassword = $bindable(true),
    password = $bindable(''),
    disabled = false
  } = $props();

  function suggestPassword() {
    password = generatePreviewPassword();
  }
</script>

<div class="preview-password-control">
  <label class="preview-password-toggle">
    <input type="checkbox" bind:checked={requirePassword} {disabled} />
    <span>Require password</span>
  </label>

  {#if requirePassword}
    <div class="preview-password-row">
      <input
        {id}
        class="preview-password-input"
        type="text"
        bind:value={password}
        disabled={disabled}
        autocomplete="off"
        spellcheck="false"
      />
      <button type="button" class="preview-password-suggest" disabled={disabled} onclick={suggestPassword}>
        Suggest
      </button>
    </div>
  {/if}
</div>

<style>
  .preview-password-control {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-secondary);
  }

  .preview-password-toggle {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .preview-password-toggle input {
    margin: 0;
  }

  .preview-password-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
  }

  .preview-password-input {
    min-width: 0;
    height: 32px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font: 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }

  .preview-password-input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-subtle);
  }

  .preview-password-suggest {
    height: 32px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }

  .preview-password-suggest:hover:not(:disabled) {
    background: var(--bg-secondary);
  }

  .preview-password-suggest:disabled,
  .preview-password-input:disabled,
  .preview-password-toggle input:disabled + span {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
