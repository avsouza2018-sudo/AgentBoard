import type { CardView } from '../store';

export function CardItem({ card, onOpen }: { card: CardView; onOpen: (taskId: string) => void }) {
  return (
    <li className={`card${card.pending ? ' pending' : ''}`} draggable onDragStart={(event) => event.dataTransfer.setData('text/plain', card.id)}>
      <button type="button" className="open" onClick={() => onOpen(card.id)}>
        <span className="key">{card.key}</span>
        <span className="title">{card.title}</span>
      </button>

      {card.lease ? (
        <p className="lease">
          held by <strong>{card.lease.agentId}</strong> until {formatTime(card.lease.expiresAt)}
        </p>
      ) : null}

      {card.pending ? <p className="pending">asked — waiting for the answer</p> : null}

      {card.refusal ? (
        <p className="refusal" role="status">
          <span className="code">{card.refusal.code}</span>
          {card.refusal.message}
        </p>
      ) : null}
    </li>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
