import type { Workflow } from '@agentboard/domain';
import type { Task } from '@agentboard/domain';

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
  lease: { agentId: string; expiresAt: string } | null;
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

export function toTaskSummary(task: Task, workflow: Workflow): TaskSummary {
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
    lease: task.lease ? { agentId: task.lease.agentId, expiresAt: task.lease.expiresAt.toISOString() } : null,
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
