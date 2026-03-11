export function getDisplayErrorMessage(err, fallback = 'An unexpected error occurred.') {
  let message = err?.message || '';
  if (!message) return fallback;

  message = message.replace(/^Error invoking remote method '[^']+': Error:\s*/i, '');
  message = message.replace(/^Something went wrong:\s*/i, '');

  return message.trim() || fallback;
}
