import { useEffect, useState } from 'react';
import type { ApiClient } from '../api';
import type { BoardStore, BoardView, CardView } from '../store';
import { Columns } from './columns';
import { Panel } from './panel';
import { useBoardView } from './useBoardView';

export function App({
  store,
  api,
  token,
  runId,
  closeLive,
}: {
  store: BoardStore;
  api: ApiClient;
  token: string;
  runId: string;
  closeLive: () => void;
}) {
  const view = useBoardView(store);
  const [open, setOpen] = useState<string | null>(null);
  const [actor, setActor] = useState<string | null>(null);

  useEffect(() => {
    void store.load();
    void api.identity().then((outcome) => {
      if (outcome.ok) setActor(outcome.data.actor.name);
    });

    return closeLive;
  }, [store, api, closeLive]);

  const card = open ? view.columns.flatMap((column) => column.cards).find((c) => c.id === open) : undefined;

  return (
    <div className="shell">
      <header className="header">
        <h1>AgentBoard</h1>
        <p className="board-name">{view.board?.name ?? 'no board yet'}</p>
        <div className="identity">
          <span className="who">{actor ?? token}</span>
          <span className="run">run {runId}</span>
          <span className={`live${view.connected ? ' on' : ''}`}>
            {view.connected ? 'reading the outbox' : 'not connected'}
          </span>
        </div>
      </header>

      <main className="board">
        <Columns view={view} onOpen={setOpen} onMove={(taskId, stateId) => void store.move(taskId, stateId, 'moved on the board')} />
      </main>

      <Panel
        store={store}
        api={api}
        view={view}
        card={card}
        onClose={() => setOpen(null)}
      />
    </div>
  );
}
