import type { ActorId, RunId } from '@agentboard/shared';
import type {
  Actor,
  ActorDirectory,
  ActorRegistry,
  ActorResolver,
  Registration,
  RegistrationProvenance,
  Tx,
} from '@agentboard/domain';
import type { Pool, PoolClient } from 'pg';
import type { ActorRow, RegistrationRow } from './mapper.js';
import { actorFromRow, registrationFromRow } from './mapper.js';
import { clientOf } from './tx.js';

/**
 * Three ports, one implementation, because they answer three different questions about the same rows.
 *
 * `resolve` answers "who is calling?" — it takes a bearer token and has no transaction, because
 * authentication happens before a unit of work is opened. `find` answers "who are we handing this
 * to?" — it takes an actor id inside the transaction, which is what escalation needs. `register`
 * answers "how does a new principal get a credential?" and mints the value itself: the domain named
 * the operation, and the adapter decides what a secret looks like, so this is the one place allowed to
 * know that a token is a uuid.
 */
export class PgActorStore implements ActorResolver, ActorDirectory, ActorRegistry {
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

  async register(tx: Tx, actor: Actor, provenance: RegistrationProvenance): Promise<string> {
    const client = clientOf(tx);
    const token = crypto.randomUUID();

    await client.query(
      `insert into actors (id, type, name, scopes) values ($1, $2, $3, $4)
       on conflict (id) do update set name = excluded.name, scopes = excluded.scopes`,
      [actor.id, actor.type, actor.name, [...actor.scopes]],
    );

    await client.query(
      `insert into api_tokens (token, actor_id, created_by, run_id) values ($1, $2, $3, $4)
       on conflict (token) do nothing`,
      [token, actor.id, provenance.actorId, provenance.runId],
    );

    return token;
  }

  async list(tx: Tx): Promise<Registration[]> {
    const client = clientOf(tx);
    const res = await client.query<RegistrationRow>(
      `select t.token, t.created_by, t.run_id, t.registered_at, a.id, a.type, a.name, a.scopes
         from api_tokens t join actors a on a.id = t.actor_id
        order by a.type, a.name`,
    );
    return res.rows.map(registrationFromRow);
  }
}
