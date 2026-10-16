import { useEffect, useState } from 'react';
import type { BoardStore, BoardView } from '../store';

/**
 * The page renders the store, it does not hold state of its own. Every fact on screen comes from
 * either the last snapshot or a committed frame, and the only thing the page adds is which card is
 * open.
 */
export function useBoardView(store: BoardStore): BoardView {
  const [view, setView] = useState(store.view);

  useEffect(() => {
    const unsubscribe = store.subscribe(() => setView(store.view));
    return unsubscribe;
  }, [store]);

  return view;
}
