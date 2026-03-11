<script>
  let {
    active = false,
    stage = 'building',
    message = 'Preparing deployment...',
    targetLabel = 'Deploying to CourseCode Cloud',
    compact = false
  } = $props();

  const stages = [
    { id: 'building', label: 'Build' },
    { id: 'uploading', label: 'Upload' },
    { id: 'complete', label: 'Ready' }
  ];

  function getStageIndex(currentStage) {
    if (currentStage === 'error') return 1;
    return Math.max(stages.findIndex((entry) => entry.id === currentStage), 0);
  }

  function getProgressWidth(currentStage) {
    if (currentStage === 'complete') return 100;
    if (currentStage === 'uploading') return 76;
    if (currentStage === 'error') return 76;
    return 34;
  }

  function getStageLabel(currentStage) {
    if (currentStage === 'complete') return 'Complete';
    if (currentStage === 'uploading') return 'Uploading';
    if (currentStage === 'error') return 'Attention';
    return 'Building';
  }

  function getStepStatus(stepIndex, currentStage) {
    if (currentStage === 'error') {
      if (stepIndex < getStageIndex(currentStage)) return 'done';
      if (stepIndex === getStageIndex(currentStage)) return 'active';
      return 'idle';
    }

    const currentIndex = getStageIndex(currentStage);
    if (currentStage === 'complete' && stepIndex <= currentIndex) return 'done';
    if (stepIndex < currentIndex) return 'done';
    if (stepIndex === currentIndex) return active ? 'active' : 'done';
    return 'idle';
  }
</script>

<div
  class:compact
  class:error={stage === 'error'}
  class:complete={stage === 'complete'}
  class="deploy-progress"
  aria-live="polite"
>
  <div class="deploy-progress-header">
    <div class="deploy-progress-copy">
      <span class="deploy-progress-eyebrow">{active ? 'Deploy in progress' : stage === 'complete' ? 'Deploy complete' : 'Deploy status'}</span>
      <strong>{targetLabel}</strong>
    </div>
    <span class="deploy-progress-badge">{getStageLabel(stage)}</span>
  </div>

  <div class="deploy-progress-steps" aria-hidden="true">
    {#each stages as step, index}
      <div class="deploy-progress-step" class:active={getStepStatus(index, stage) === 'active'} class:done={getStepStatus(index, stage) === 'done'}>
        <span class="deploy-progress-dot"></span>
        <span>{step.label}</span>
      </div>
    {/each}
  </div>

  <div class="deploy-progress-bar" aria-hidden="true">
    <span style={`width: ${getProgressWidth(stage)}%`}></span>
  </div>

  <p>{message}</p>
</div>

<style>
  .deploy-progress {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    padding: 12px;
    border-radius: var(--radius-md);
    border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--border));
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--accent-subtle) 65%, transparent), transparent 85%),
      var(--bg-elevated);
    box-shadow: var(--shadow-sm);
  }

  .deploy-progress.compact {
    width: min(320px, calc(100vw - 48px));
    padding: 10px;
    gap: 6px;
  }

  .deploy-progress.error {
    border-color: color-mix(in srgb, var(--error) 35%, var(--border));
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--error-subtle) 82%, transparent), transparent 85%),
      var(--bg-elevated);
  }

  .deploy-progress.complete {
    border-color: color-mix(in srgb, var(--success) 28%, var(--border));
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--success-subtle) 82%, transparent), transparent 85%),
      var(--bg-elevated);
  }

  .deploy-progress-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
  }

  .deploy-progress-copy {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .deploy-progress-copy strong {
    font-size: var(--text-sm);
    line-height: 1.35;
  }

  .deploy-progress-eyebrow {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-tertiary);
  }

  .deploy-progress-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 22px;
    padding: 0 8px;
    border-radius: var(--radius-pill);
    background: color-mix(in srgb, var(--bg-primary) 55%, transparent);
    color: var(--text-secondary);
    font-size: 10px;
    font-weight: 700;
    white-space: nowrap;
  }

  .deploy-progress.complete .deploy-progress-badge {
    background: color-mix(in srgb, var(--success) 14%, transparent);
    color: var(--success);
  }

  .deploy-progress.error .deploy-progress-badge {
    background: color-mix(in srgb, var(--error) 14%, transparent);
    color: var(--error);
  }

  .deploy-progress-steps {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
  }

  .deploy-progress-step {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    color: var(--text-tertiary);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }

  .deploy-progress-step.done,
  .deploy-progress-step.active {
    color: var(--text-primary);
  }

  .deploy-progress.error .deploy-progress-step.active {
    color: var(--error);
  }

  .deploy-progress.complete .deploy-progress-step.done {
    color: var(--success);
  }

  .deploy-progress-dot {
    width: 8px;
    height: 8px;
    flex: 0 0 auto;
    border-radius: 999px;
    background: color-mix(in srgb, var(--border) 80%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--border-strong) 70%, transparent);
  }

  .deploy-progress-step.done .deploy-progress-dot,
  .deploy-progress-step.active .deploy-progress-dot {
    background: var(--accent);
    box-shadow: none;
  }

  .deploy-progress.complete .deploy-progress-step.done .deploy-progress-dot {
    background: var(--success);
  }

  .deploy-progress.error .deploy-progress-step.active .deploy-progress-dot {
    background: var(--error);
  }

  .deploy-progress-bar {
    width: 100%;
    height: 6px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--bg-primary) 50%, var(--border));
    overflow: hidden;
  }

  .deploy-progress-bar span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 80%, #fff), var(--accent));
    transition: width var(--duration-normal) var(--ease);
  }

  .deploy-progress.complete .deploy-progress-bar span {
    background: linear-gradient(90deg, color-mix(in srgb, var(--success) 72%, #fff), var(--success));
  }

  .deploy-progress.error .deploy-progress-bar span {
    background: linear-gradient(90deg, color-mix(in srgb, var(--error) 72%, #fff), var(--error));
  }

  p {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--text-xs);
    line-height: 1.45;
  }
</style>
