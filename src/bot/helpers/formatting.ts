export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function formatTimer(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'OFF';
  if (seconds % 86400 === 0) return seconds / 86400 + ' day(s)';
  if (seconds % 3600 === 0) return seconds / 3600 + ' hour(s)';
  if (seconds % 60 === 0) return seconds / 60 + ' minute(s)';
  return seconds + ' second(s)';
}
