import type { BoardId, StateId } from '@agentboard/shared';
import type { Role } from './actor.js';

export type StateCategory = 'todo' | 'in_progress' | 'done';

export interface WorkflowState {
  id: StateId;
  name: string;
  category: StateCategory;
  /** States flagged as a human gate cannot be entered by an agent actor. */
  isHumanGate: boolean;
  wipLimit: number | null;
  order: number;
}

export interface Transition {
  id: string;
  from: StateId;
  to: StateId;
  name: string;
  allowedRoles: readonly Role[];
  /** Field names that must be non-empty before the move is allowed. */
  requiredFields: readonly string[];
}

export class Workflow {
  readonly id: string;
  readonly boardId: BoardId;
  readonly name: string;
  readonly states: readonly WorkflowState[];
  readonly transitions: readonly Transition[];

  constructor(args: {
    id: string;
    boardId: BoardId;
    name: string;
    states: readonly WorkflowState[];
    transitions: readonly Transition[];
  }) {
    this.id = args.id;
    this.boardId = args.boardId;
    this.name = args.name;
    this.states = args.states;
    this.transitions = args.transitions;
  }

  state(stateId: StateId): WorkflowState | undefined {
    return this.states.find((s) => s.id === stateId);
  }

  findTransition(from: StateId, to: StateId): Transition | undefined {
    return this.transitions.find((t) => t.from === from && t.to === to);
  }

  orderedStates(): WorkflowState[] {
    return [...this.states].sort((a, b) => a.order - b.order);
  }
}
