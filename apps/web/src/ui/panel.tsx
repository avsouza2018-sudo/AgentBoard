import { useEffect, useState } from 'react';
import type { ApiClient } from '../api';
import type { TaskDetail } from '../contract';
import type { BoardStore, BoardView, CardView, FeedItem } from '../store';

/**
 * One panel, two modes: the card you opened, or the board's history when nothing is open.
 *
 * The transition buttons are the workflow graph as the server described it. They are not filtered by
 * role, because filtering them here would be a second copy of the rule the domain already has — and
 * the copy that drifts is the one in the browser. A button you are not allowed to use answers with a
 * refusal, and the refusal is the domain's own sentence.
 */
export function Panel({
  store,
  api,
  view,
  card,
  onClose,
}: {
  store: BoardStore;
  api: ApiClient;
  view: BoardView;
  card: CardView | undefined;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);

  useEffect(() => {
    if (!card) {
      setDetail(null);
      return;
    }

    let alive = true;
    void api.task(card.id).then((outcome) => {
      if (alive && outcome.ok) setDetail(outcome.data);
    });

    return () => {
      alive = false;
    };
  }, [api, card?.id]);

  if (!card) {
    return (
      <aside className="panel">
        <h2>Board activity</h2>
        <Feed items={view.feed} />
      </aside>
    );
  }

  const transitions = store.transitionsFrom(card.statusId);

  return (
    <aside className="panel">
      <button type="button" className="close" onClick={onClose}>
        Close
      </button>

      <p className="key">{card.key}</p>
      <h2>{card.title}</h2>
      <p className="where">
        in {card.statusName} · version {card.version} · updated {formatTime(card.updatedAt)}
      </p>

      {detail ? (
        <>
          {detail.description ? <p className="description">{detail.description}</p> : null}

          {detail.acceptanceCriteria.length > 0 ? (
            <>
              <h3>Acceptance criteria</h3>
              <ul className="criteria">
                {detail.acceptanceCriteria.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      ) : null}

      <h3>Move this card</h3>
      {transitions.length === 0 ? <p className="empty">This column has no way out.</p> : null}
      <ul className="transitions">
        {transitions.map((transition) => (
          <li key={transition.id}>
            <button
              type="button"
              onClick={() => void store.move(card.id, transition.to, 'moved from the card drawer')}
            >
              {transition.name}
            </button>
            <span className="to">{nameOf(view, transition.to)}</span>
          </li>
        ))}
      </ul>

      {card.refusal ? (
        <p className="refusal" role="status">
          <span className="code">{card.refusal.code}</span>
          {card.refusal.message}
        </p>
      ) : null}

      {detail && detail.comments.length > 0 ? (
        <>
          <h3>Comments</h3>
          <ul className="comments">
            {detail.comments.map((comment) => (
              <li key={comment.id}>
                <span className="kind">{comment.kind}</span>
                <span className="by">{comment.authorId}</span>
                {comment.runId ? <span className="runid">{comment.runId}</span> : null}
                <p>{comment.body}</p>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <h3>History for this card</h3>
      <Feed items={view.feed.filter((item) => item.taskId === card.id)} />
    </aside>
  );
}

function Feed({ items }: { items: FeedItem[] }) {
  if (items.length === 0) return <p className="empty">Nothing has happened on this board yet.</p>;

  return (
    <ul className="feed">
      {items.map((item) => (
        <li key={item.id ?? `${item.event}-${item.at}`}>
          <span className="event">{item.event}</span>
          <span className="by">{item.actorId ?? '—'}</span>
          {item.runId ? <span className="runid">{item.runId}</span> : null}
          <span className="at">{formatTime(item.at)}</span>
        </li>
      ))}
    </ul>
  );
}

function nameOf(view: BoardView, stateId: string): string {
  return view.workflow?.states.find((s) => s.id === stateId)?.name ?? stateId;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
