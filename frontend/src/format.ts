export function formatDate(iso: string, compact = false): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  if (compact) {
    const now = new Date();
    if (date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  }
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** "Alice <alice@example.com>" -> "alice@example.com" */
export function addressOf(entry: string): string {
  const match = /<([^>]+)>\s*$/.exec(entry);
  return (match?.[1] ?? entry).trim().toLowerCase();
}

/** "Alice <alice@example.com>" -> "Alice" */
export function displayName(entry: string): string {
  const match = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(entry);
  return match?.[1] || entry;
}
