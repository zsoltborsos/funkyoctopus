/** Last two path segments — enough to place a chat without a full path. */
export function folderOf(cwd: string): string {
  return cwd.split('/').filter(Boolean).slice(-2).join('/');
}

/** Coarse recency — enough to find a chat, not a timestamp read-out. */
export function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
