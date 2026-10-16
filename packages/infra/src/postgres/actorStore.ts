import type { ActorId } from '@agentboard/shared';
import type { Actor, ActorDirectory, ActorResolver, Tx } from '@agentboard/domain';
import type { Pool, PoolClient } from 'pg';
import type { ActorRow } from './mapper.js';
import { actorFromRow } from './mapper.js';
import { clientOf } from './tx.js';

/**
 * Two ports, one implementation, because they answer two different questions.
 *
 * `resolve` answers "who is calling?" — it takes a bearer token and has no transaction, because
 * authentication happens before a unit of work is opened. `find` answers "who are we handing this
 * to?" — it takes an actor id inside the transaction, which is what escalation needs.
 */
export class PgActorStore implements ActorResolver, ActorDirectory {
  constructor(private readonly pool: Pool) {}

  async resolve(token: string): Promise<Actor | null> {
    const res = await this.pool.query<ActorRow>(
      `select a.id, a.type, a.name, a.scopes
         from api_tokens t join actors a on a.id = t.actor_id
        where t.token = $1`,
      [token],
    );
    const row = res.rows[0];
    return row ? actorFromRow(row) : null;
  }

  async find(tx: Tx, actorId: ActorId): Promise<Actor | null> {
    const client = clientOf(tx);
    const res = await client.query<ActorRow>('select id, type, name, scopes from actors where id = $1', [actorId]);
    const row = res.rows[0];
    return row ? actorFromRow(row) : null;
  }

  async register(actor: Actor, token: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `insert into actors (id, type, name, scopes) values ($1, $2, $3, $4)
         on conflict (id) do update set name = excluded.name, scopes = excluded.scopes`,
        [actor.id, actor.type, actor.name, [...actor.scopes]],
      );
      await client.query(
        `insert into api_tokens (token, actor_id) values ($1, $2) on conflict (token) do nothing`,
        [token, actor.id],
      );
    } finally {
      client.release();
    }
  }
}
