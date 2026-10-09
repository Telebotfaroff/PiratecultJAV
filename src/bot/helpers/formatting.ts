export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Format a duration using the largest useful units without losing the
 * remaining time (for example, 3660 seconds becomes "1 hour 1 minute").
 */
export function formatTimer(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'OFF';

  let remaining = Math.floor(seconds);
  if (remaining <= 0) return 'OFF';

  const units: Array<[string, number]> = [
    ['day(s)', 86400],
    ['hour(s)', 3600],
    ['minute(s)', 60],
  ];
  const parts: string[] = [];

  for (const [label, unitSeconds] of units) {
    const amount = Math.floor(remaining / unitSeconds);
    if (amount > 0) {
      parts.push(`${amount} ${label}`);
      remaining %= unitSeconds;
    }
  }

  if (remaining > 0 || parts.length === 0) {
    parts.push(`${remaining} second(s)`);
  }

  return parts.join(' ');
}
