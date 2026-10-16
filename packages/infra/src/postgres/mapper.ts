import type { ActorId, BoardId, RunId, StateId, TaskId } from '@agentboard/shared';
import type {
  Actor,
  ActivityEvent,
  Comment,
  CommentKind,
  Lease,
  Membership,
  Priority,
  Role,
  Scope,
  Task,
  Workflow,
  WorkflowState,
} from '@agentboard/domain';
import { id } from '@agentboard/shared';
import { Board as BoardModel, Task as TaskModel, Workflow as WorkflowModel } from '@agentboard/domain';

/**
 * Rows are mapped to aggregates here and nowhere else. A repository should never hand a raw
 * row upward: the domain would then know that a table exists.
 */

export interface TaskRow {
  id: string;
  board_id: string;
  key: string;
  title: string;
  description: string;
  status_id: string;
  priority: string;
  assignee_id: string | null;
  reporter_id: string;
  labels: string[];
  acceptance_criteria: string[];
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface CommentRow {
  id: string;
  task_id: string;
  author_id: string;
  kind: string;
  body: string;
  run_id: string | null;
  created_at: Date;
}

export interface LeaseRow {
  task_id: string;
  agent_id: string;
  acquired_at: Date;
  expires_at: Date;
  renew_count: number;
}

export interface ActivityRow {
  id: string;
  board_id: string;
  task_id: string;
  actor_id: string;
  run_id: string | null;
  type: string;
  at: Date;
  payload: Record<string, unknown>;
}

export interface BoardRow {
  id: string;
  name: string;
  slug: string;
  workflow_id: string;
}

export interface MembershipRow {
  actor_id: string;
  role: string;
}

export interface WorkflowRow {
  id: string;
  board_id: string;
  name: string;
}

export interface StateRow {
  id: string;
  name: string;
  category: string;
  is_human_gate: boolean;
  wip_limit: number | null;
  order: number;
}

export interface TransitionRow {
  id: string;
  from_state: string;
  to_state: string;
  name: string;
  allowed_roles: string[];
  required_fields: string[];
}

export interface ActorRow {
  id: string;
  type: string;
  name: string;
  scopes: string[];
}

export function taskFromRow(
  row: TaskRow,
  comments: CommentRow[],
  blockers: string[],
  leaseRow: LeaseRow | null,
): Task {
  return new TaskModel({
    id: id<TaskId>(row.id),
    boardId: id<BoardId>(row.board_id),
    key: row.key,
    title: row.title,
    description: row.description,
    statusId: id<StateId>(row.status_id),
    priority: row.priority as Priority,
    assigneeId: row.assignee_id ? id<ActorId>(row.assignee_id) : null,
    reporterId: id<ActorId>(row.reporter_id),
    labels: row.labels,
    blockedBy: blockers.map((b) => id<TaskId>(b)),
    acceptanceCriteria: row.acceptance_criteria,
    comments: comments.map((c) => ({
      id: c.id,
      taskId: id<TaskId>(c.task_id),
      authorId: id<ActorId>(c.author_id),
      kind: c.kind as CommentKind,
      body: c.body,
      runId: c.run_id ? id<RunId>(c.run_id) : null,
      createdAt: c.created_at,
    })),
    lease: leaseRow
      ? {
          taskId: id<TaskId>(leaseRow.task_id),
          agentId: id<ActorId>(leaseRow.agent_id),
          acquiredAt: leaseRow.acquired_at,
          expiresAt: leaseRow.expires_at,
          renewCount: leaseRow.renew_count,
        }
      : null,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function activityFromRow(row: ActivityRow): ActivityEvent {
  return {
    id: row.id,
    boardId: id<BoardId>(row.board_id),
    taskId: id<TaskId>(row.task_id),
    actorId: id<ActorId>(row.actor_id),
    runId: row.run_id ? id<RunId>(row.run_id) : null,
    type: row.type as ActivityEvent['type'],
    at: row.at,
    payload: row.payload,
  };
}

export function boardFromRow(row: BoardRow, members: MembershipRow[]): BoardModel {
  return new BoardModel({
    id: id<BoardId>(row.id),
    name: row.name,
    slug: row.slug,
    workflowId: row.workflow_id,
    members: members.map((m) => ({ actorId: id<ActorId>(m.actor_id), role: m.role as Role })),
  });
}

export function workflowFromRow(row: WorkflowRow, states: StateRow[], transitions: TransitionRow[]): WorkflowModel {
  return new WorkflowModel({
    id: row.id,
    boardId: id<BoardId>(row.board_id),
    name: row.name,
    states: states.map((s) => ({
      id: id<StateId>(s.id),
      name: s.name,
      category: s.category as WorkflowState['category'],
      isHumanGate: s.is_human_gate,
      wipLimit: s.wip_limit === null ? null : Number(s.wip_limit),
      order: Number(s.order),
    })),
    transitions: transitions.map((t) => ({
      id: t.id,
      from: id<StateId>(t.from_state),
      to: id<StateId>(t.to_state),
      name: t.name,
      allowedRoles: t.allowed_roles as Role[],
      requiredFields: t.required_fields,
    })),
  });
}

export function actorFromRow(row: ActorRow): Actor {
  return {
    id: id<ActorId>(row.id),
    type: row.type as Actor['type'],
    name: row.name,
    scopes: row.scopes as Scope[],
  };
}
