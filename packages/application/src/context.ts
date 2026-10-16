import type { RunId } from '@agentboard/shared';

/** Every call carries an actor and, for agents, the run that produced it. */
export interface CallContext {
  actorToken: string;
  runId: RunId | null;
}
