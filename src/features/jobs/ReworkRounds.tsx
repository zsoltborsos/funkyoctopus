import type { HelmraiserReworkRequest } from '@shared/transport/protocol.ts';

/** The rounds a run has already been sent back for: the round, whether it rebased, and the note given. */
export function ReworkRounds({ rounds }: { rounds: HelmraiserReworkRequest[] }) {
  return (
    <ul aria-label="Earlier rework rounds" className="mt-2 space-y-2 rounded border border-border bg-bg p-3 text-xs">
      {rounds.map((round) => (
        <li key={round.round}>
          <span className="tracking-widest text-accent">Round {round.round}{round.rebase ? ' · rebase' : ''}</span>
          {/* Notes are the owner's own words and can run long: a bounded scroll area, line breaks kept. */}
          <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap wrap-anywhere text-text select-text">{round.note}</pre>
        </li>
      ))}
    </ul>
  );
}
