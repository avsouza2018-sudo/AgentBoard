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
          {/* The word is the server's. This component compares nothing against a clock: the read model
             already said whether the lease is held, expiring or expired, and copying that word is the
             whole job here. When `status` is null the shape came from a write response, which carries a
             lease but no status — so the card shows the fact without inventing a word. */}
          held by <strong>{card.lease.agentId}</strong> until {formatTime(card.lease.expiresAt)}
          {card.lease.status ? <span className={`status ${card.lease.status}`}>{card.lease.status}</span> : null}
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
