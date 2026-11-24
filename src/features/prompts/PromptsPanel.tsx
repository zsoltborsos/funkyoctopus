import { useShell } from '@core/shell/useShell.ts';
import { usePromptLibrary } from './usePromptLibrary.ts';

/**
 * The prompt library as a quick-*select*: saved templates are picked here and
 * loaded into the chat composer (via the shell), where they can be edited and
 * sent. Templates are created from chat with "save as template", not typed into
 * a cramped tile here — so this view is all readable cards and one-click reuse.
 */
export function PromptsPanel() {
  const { prompts, remove } = usePromptLibrary();
  const { composeInChat } = useShell();

  return (
    <section className="flex h-full w-full flex-col gap-4 overflow-hidden rounded-lg border border-border bg-surface/40 p-5">
      <header>
        <h2 className="font-mono text-sm tracking-widest text-accent">PROMPT TEMPLATES</h2>
        <p className="mt-1 font-mono text-xs text-muted">
          pick one to load it into the chat composer
        </p>
      </header>

      {prompts.length === 0 ? (
        <p className="font-mono text-sm text-muted">
          no templates yet — write a message in chat and hit “save as template”.
        </p>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          {prompts.map((p) => (
            <li
              key={p.id}
              className="group flex items-start justify-between gap-3 rounded border border-border bg-bg/40 p-3 hover:border-accent/50"
            >
              <button
                type="button"
                onClick={() => composeInChat(p.body)}
                title="Load into chat composer"
                className="flex min-w-0 flex-1 flex-col gap-1 text-left"
              >
                <span className="truncate font-mono text-sm text-accent">{p.title}</span>
                <span className="line-clamp-3 whitespace-pre-wrap font-mono text-xs text-muted group-hover:text-text">
                  {p.body}
                </span>
              </button>
              <button
                type="button"
                onClick={() => remove(p.id)}
                aria-label={`Delete ${p.title}`}
                className="shrink-0 font-mono text-sm text-muted hover:text-danger"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
