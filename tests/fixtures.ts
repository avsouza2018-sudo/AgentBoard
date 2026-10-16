import { id, type ActorId, type BoardId, type StateId } from '@agentboard/shared';
import type { Actor, Membership, Transition, WorkflowState } from '@agentboard/domain';

/**
 * One fixture, shared by both harnesses. The parity test is only meaningful if the board, the
 * workflow and the actors are literally the same objects in the in-memory and Postgres runs.
 */

export const BOARD = id<BoardId>('board-1');
export const AGENT = id<ActorId>('agent-atlas');
export const HUMAN = id<ActorId>('human-ada');

export const STATES = {
  todo: id<StateId>('s-todo'),
  inProgress: id<StateId>('s-inprogress'),
  review: id<StateId>('s-review'),
  done: id<StateId>('s-done'),
};

export const MEMBERSHIPS: Membership[] = [
  { actorId: AGENT, role: 'agent' },
  { actorId: HUMAN, role: 'admin' },
];

export const STATE_ROWS: WorkflowState[] = [
  { id: STATES.todo, name: 'To Do', category: 'todo', isHumanGate: false, wipLimit: null, order: 1 },
  { id: STATES.inProgress, name: 'In Progress', category: 'in_progress', isHumanGate: false, wipLimit: 2, order: 2 },
  { id: STATES.review, name: 'Human Review', category: 'in_progress', isHumanGate: true, wipLimit: null, order: 3 },
  { id: STATES.done, name: 'Done', category: 'done', isHumanGate: false, wipLimit: null, order: 4 },
];

export const TRANSITION_ROWS: Transition[] = [
  { id: 't1', from: STATES.todo, to: STATES.inProgress, name: 'start', allowedRoles: ['agent', 'member', 'admin'], requiredFields: [] },
  { id: 't2', from: STATES.inProgress, to: STATES.review, name: 'hand off', allowedRoles: ['agent', 'member', 'admin'], requiredFields: ['acceptanceCriteria'] },
  { id: 't3', from: STATES.review, to: STATES.done, name: 'approve', allowedRoles: ['admin'], requiredFields: [] },
];

export const AGENT_ACTOR: Actor = {
  id: AGENT,
  type: 'agent',
  name: 'atlas',
  scopes: ['read', 'write', 'transition', 'comment'],
};

export const HUMAN_ACTOR: Actor = {
  id: HUMAN,
  type: 'human',
  name: 'ada',
  scopes: ['read', 'write', 'transition', 'comment'],
};

export const AGENT_TOKEN = 'tok-agent-atlas';
export const HUMAN_TOKEN = 'tok-human-ada';

export const WORKFLOW_ID = 'wf-board-1';
export const BOARD_SLUG = 'AG';
export const BOARD_NAME = 'Agent Work';
