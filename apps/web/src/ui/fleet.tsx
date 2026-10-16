import type { BoardView } from '../store';

/**
 * The roster: who is on the board, who minted each credential, and what each principal is holding at
 * the instant the server answered.
 *
 * The status word on a held card is the server's, copied verbatim. This strip does not compare a
 * timestamp against a clock — that is the same rule the rest of the page follows: the UI renders what
 * the read model said, and a page that decided "this lease looks stale" would be a second definition of
 * staleness, and the second definition is the one that drifts.
 */
export function Fleet({ view, onOpen }: { view: BoardView; onOpen: (taskId: string) => void }) {
  if (view.agents.length === 0) return null;

  return (
    <section className="fleet" aria-label="the roster">
      {view.agents.map((agent) => (
        <article key={agent.id} className={`member ${agent.type}`}>
          <header>
            <h2>{agent.name}</h2>
            <p className="meta">
              <span className="role">{agent.role}</span>
              {/* The audit trail can name the token; only the registry can name who minted it. */}
              <span className="minted">{agent.registeredBy ? `minted by ${agent.registeredBy}` : 'the seed credential'}</span>
            </p>
          </header>

          <ul className="held">
            {agent.held.length === 0 ? (
              <li className="none">nothing held in this read</li>
            ) : (
              agent.held.map((task) => (
                <li key={task.id}>
                  <button type="button" onClick={() => onOpen(task.id)}>
                    <span className="key">{task.key}</span>
                    <span className={`lease-status ${task.lease?.status ?? 'none'}`}>{task.lease?.status ?? 'none'}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </article>
      ))}
    </section>
  );
}
