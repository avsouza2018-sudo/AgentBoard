import type { BoardView, CardView } from '../store';
import { CardItem } from './card';

export function Columns({
  view,
  onOpen,
  onMove,
}: {
  view: BoardView;
  onOpen: (taskId: string) => void;
  onMove: (taskId: string, stateId: string) => void;
}) {
  return (
    <div className="columns">
      {view.columns.map((column) => (
        <section
          key={column.stateId}
          className={`column${column.isHumanGate ? ' is-gate' : ''}`}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const taskId = event.dataTransfer.getData('text/plain');
            // The page does not check whether this column is reachable from where the card is.
            // It asks, and the domain answers — the answer is either the aggregate or a refusal.
            if (taskId) onMove(taskId, column.stateId);
          }}
        >
          <h2>
            {column.name}
            <span className="count">
              {column.count}
              {column.wipLimit !== null ? ` of ${column.wipLimit}` : ''}
            </span>
          </h2>

          {column.isHumanGate ? <p className="gate-note">Only a human can move a card out of here.</p> : null}

          {column.cards.length === 0 ? <p className="empty">Nothing in this column yet.</p> : null}

          <ul className="cards">
            {column.cards.map((card: CardView) => (
              <CardItem key={card.id} card={card} onOpen={onOpen} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
