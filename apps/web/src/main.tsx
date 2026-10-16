import { createRoot } from 'react-dom/client';
import { ApiClient } from './api';
import { connect } from './live';
import { BoardStore } from './store';
import { App } from './ui/app';
import './styles.css';

/**
 * The page is an actor like any agent: it has a token and a run. The token is typed here because
 * identity is an input to the system, not something the page assumes — the same resolver answers for
 * a browser and for a stdio client.
 */
const params = new URLSearchParams(window.location.search);
const token = params.get('token') ?? 'tok-agent-atlas';
const boardId = params.get('board') ?? 'board-1';
const runId = params.get('run') ?? `run-page-${Math.random().toString(36).slice(2, 8)}`;

const api = new ApiClient({ baseUrl: '', token, runId });
const store = new BoardStore(api, boardId);

async function start(): Promise<void> {
  const connection = await connect(api.eventsUrl(boardId), token, (frame) => store.applyFrame(frame));

  createRoot(document.getElementById('root')!).render(
    <App store={store} api={api} token={token} runId={runId} closeLive={connection.close} />,
  );
}

start().catch((error: unknown) => {
  const root = document.getElementById('root');
  if (root) root.textContent = `the live feed did not connect: ${error instanceof Error ? error.message : String(error)}`;
});
