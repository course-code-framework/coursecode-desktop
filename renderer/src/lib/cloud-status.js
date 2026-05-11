export function isGithubLinkedStatus(status) {
  if (!status) return false;

  return (
    status.source?.type === 'github' ||
    status.source_type === 'github' ||
    status.sourceType === 'github' ||
    !!status.github_repo ||
    !!status.githubRepo ||
    !!status.source?.githubRepo ||
    status.source?.directProductionDeployAllowed === false
  );
}
