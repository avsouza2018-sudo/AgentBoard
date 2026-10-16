import type { LeaseStatus, Workflow } from '@agentboard/domain';
import { leaseStatus } from '@agentboard/domain';
import type { Task } from '@agentboard/domain';

/**
 * A lease as the read model reports it. `status` is the domain's word, not the page's: the same
 * policy that refuses a `result` comment on an expired lease is what names `expiring` here, so the
 * board and the page cannot disagree about the same card.
 */
export interface LeaseView {
  agentId: string;
  expiresAt: string;
  status: LeaseStatus;
}

export interface TaskSummary {
  id: string;
  key: string;
  title: string;
  statusId: string;
  statusName: string;
  priority: string;
  assigneeId: string | null;
  labels: string[];
  blockedBy: string[];
  lease: LeaseView | null;
  version: number;
  updatedAt: string;
}

export interface CommentDto {
  id: string;
  authorId: string;
  kind: string;
  body: string;
  runId: string | null;
  createdAt: string;
}

export interface ActivityDto {
  id: string;
  type: string;
  actorId: string;
  runId: string | null;
  at: string;
  payload: Record<string, unknown>;
}

export function toTaskSummary(task: Task, workflow: Workflow, now: Date): TaskSummary {
  const state = workflow.state(task.statusId);
  return {
    id: task.id,
    key: task.key,
    title: task.title,
    statusId: task.statusId,
    statusName: state?.name ?? task.statusId,
    priority: task.priority,
    assigneeId: task.assigneeId,
    labels: task.labels,
    blockedBy: task.blockedBy,
    lease: task.lease
      ? {
          agentId: task.lease.agentId,
          expiresAt: task.lease.expiresAt.toISOString(),
          status: leaseStatus(task.lease, now),
        }
      : null,
    version: task.version,
    updatedAt: task.updatedAt.toISOString(),
  };
}

export function toCommentDto(c: import('@agentboard/domain').Comment): CommentDto {
  return {
    id: c.id,
    authorId: c.authorId,
    kind: c.kind,
    body: c.body,
    runId: c.runId,
    createdAt: c.createdAt.toISOString(),
  };
}

export function toActivityDto(a: import('@agentboard/domain').ActivityEvent): ActivityDto {
  return {
    id: a.id,
    type: a.type,
    actorId: a.actorId,
    runId: a.runId,
    at: a.at.toISOString(),
    payload: a.payload,
  };
}
