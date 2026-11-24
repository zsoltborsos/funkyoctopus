import { notInstalledLine, type OptionalTool } from './humane-error.ts';

/**
 * The one line a view shows in place of itself when an optional tool is not
 * installed: dim, because FunkyOctopus works without it and nothing is wrong.
 */
export function NotInstalled({ tool }: { tool: OptionalTool }) {
  const { text, url } = notInstalledLine(tool);
  return (
    <p role="status" className="font-mono text-sm text-muted">
      {text}{' '}
      <a href={url} target="_blank" rel="noreferrer" className="underline hover:text-text">{url}</a>
    </p>
  );
}
