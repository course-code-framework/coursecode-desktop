export function toProjectDirectoryName(name) {
  return String(name || '')
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function projectLocationPreview(parentDir, displayName) {
  const directoryName = toProjectDirectoryName(displayName);
  const leaf = directoryName || '...';
  if (!parentDir) return leaf;
  return `${parentDir.replace(/[/\\]+$/g, '')}/${leaf}`;
}
