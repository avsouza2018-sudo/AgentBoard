import { z } from 'zod';
import { id, type ActorId, type BoardId, type StateId, type TaskId } from '@agentboard/shared';
import { defineTool, type ToolDefinition } from '../toolRegistry.js';

const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

const PRIORITY = z.enum(['lowest', 'low', 'medium', 'high', 'highest']);
const COMMENT_KIND = z.enum(['note', 'result', 'question', 'handoff', 'escalation']);

/**
 * The write half. Descriptions say what a tool refuses, because an agent plans from the
 * description: "cannot enter a human-gate state", "cannot start while blockers are open".
 * Every tool here still calls exactly one use case — the descriptions are not the enforcement.
 */
export const WRITE_TOOLS: ToolDefinition[] = [
  defineTool(
    {
      name: 'create_task',
      title: 'Create task',
      description:
        'Create a card on a board. It lands on the workflow start state and the key is allocated from the board sequence — keys are never reused.',
      kind: 'write',
      annotations: WRITE,
      route: { method: 'POST', path: '/api/boards/{board_id}/tasks' },
      useCase: 'createTask',
    },
    z.object({
      board_id: z.string().min(1),
      title: z.string().min(1),
      description: z.string().optional(),
      priority: PRIORITY.optional(),
      labels: z.array(z.string()).optional(),
      acceptance_criteria: z.array(z.string()).optional(),
      blocked_by: z.array(z.string()).optional(),
    }),
    (app, ctx, args) =>
      app.createTask.execute({
        ...ctx,
        boardId: id<BoardId>(args.board_id),
        title: args.title,
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.priority !== undefined ? { priority: args.priority } : {}),
        ...(args.labels !== undefined ? { labels: args.labels } : {}),
        ...(args.acceptance_criteria !== undefined ? { acceptanceCriteria: args.acceptance_criteria } : {}),
        ...(args.blocked_by !== undefined ? { blockedBy: args.blocked_by.map((b) => id<TaskId>(b)) } : {}),
      }),
  ),

  defineTool(
    {
      name: 'update_task',
      title: 'Update task',
      description:
        'Change fields only — never the state. Moving a card is move_task, because a move is a guarded transition and an edit is not.',
      kind: 'write',
      annotations: WRITE,
      route: { method: 'POST', path: '/api/tasks/{task_id}' },
      useCase: 'updateTask',
    },
    z.object({
      task_id: z.string().min(1),
      title: z.string().min(1).optional(),
      description: z.string().optional(),
      priority: PRIORITY.optional(),
      labels: z.array(z.string()).optional(),
      acceptance_criteria: z.array(z.string()).optional(),
    }),
    (app, ctx, args) =>
      app.updateTask.execute({
        ...ctx,
        taskId: id<TaskId>(args.task_id),
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.priority !== undefined ? { priority: args.priority } : {}),
        ...(args.labels !== undefined ? { labels: args.labels } : {}),
        ...(args.acceptance_criteria !== undefined ? { acceptanceCriteria: args.acceptance_criteria } : {}),
      }),
  ),

  defineTool(
    {
      name: 'move_task',
      title: 'Move card',
      description:
        'Move a card along the workflow graph. Refuses: a transition that does not exist, a human-gate state for an agent, a full state, open blockers, and missing required fields. reason is required and lands in the audit trail; force_reason overrides the blocker guard and is recorded as an override.',
      kind: 'write',
      annotations: WRITE,
      route: { method: 'POST', path: '/api/tasks/{task_id}/move' },
      useCase: 'moveTask',
    },
    z.object({
      task_id: z.string().min(1),
      to_state_id: z.string().min(1),
      reason: z.string().min(1),
      force_reason: z.string().min(1).optional(),
    }),
    (app, ctx, args) =>
      app.moveTask.execute({
        ...ctx,
        taskId: id<TaskId>(args.task_id),
        toStateId: id<StateId>(args.to_state_id),
        reason: args.reason,
        ...(args.force_reason !== undefined ? { forceReason: args.force_reason } : {}),
      }),
  ),

  defineTool(
    {
      name: 'claim_task',
      title: 'Claim task',
      description:
        'Take the lease on a card. Refuses if another agent still holds it. auto_start takes the guarded transition into an in_progress state when one exists.',
      kind: 'write',
      annotations: WRITE,
      route: { method: 'POST', path: '/api/tasks/{task_id}/claim' },
      useCase: 'claimTask',
    },
    z.object({
      task_id: z.string().min(1),
      auto_start: z.boolean().optional(),
      reason: z.string().min(1).optional(),
    }),
    (app, ctx, args) =>
      app.claimTask.execute({
        ...ctx,
        taskId: id<TaskId>(args.task_id),
        ...(args.auto_start !== undefined ? { autoStart: args.auto_start } : {}),
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
      }),
  ),

  defineTool(
    {
      name: 'release_task',
      title: 'Release task',
      description: 'Drop the lease. Allowed for the holder, or for a human clearing a stale lease.',
      kind: 'write',
      annotations: WRITE,
      route: { method: 'POST', path: '/api/tasks/{task_id}/release' },
      useCase: 'releaseTask',
    },
    z.object({
      task_id: z.string().min(1),
      unassign: z.boolean().optional(),
      reason: z.string().min(1).optional(),
    }),
    (app, ctx, args) =>
      app.releaseTask.execute({
        ...ctx,
        taskId: id<TaskId>(args.task_id),
        ...(args.unassign !== undefined ? { unassign: args.unassign } : {}),
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
      }),
  ),

  defineTool(
    {
      name: 'renew_lease',
      title: 'Renew lease',
      description:
        'Heartbeat for a long-running agent. Only the holder can renew; an expired lease is not renewed, it is reclaimed by whoever claims the task next.',
      kind: 'write',
      annotations: WRITE,
      route: { method: 'POST', path: '/api/tasks/{task_id}/lease' },
      useCase: 'renewLease',
    },
    z.object({ task_id: z.string().min(1) }),
    (app, ctx, args) => app.renewLease.execute({ ...ctx, taskId: id<TaskId>(args.task_id) }),
  ),

  defineTool(
    {
      name: 'add_comment',
      title: 'Add comment',
      description: 'Write a comment as the caller. A result comment requires holding the lease; the comment records the run that produced it.',
      kind: 'write',
      annotations: WRITE,
      route: { method: 'POST', path: '/api/tasks/{task_id}/comments' },
      useCase: 'addComment',
    },
    z.object({
      task_id: z.string().min(1),
      kind: COMMENT_KIND,
      body: z.string().min(1),
    }),
    (app, ctx, args) =>
      app.addComment.execute({ ...ctx, taskId: id<TaskId>(args.task_id), kind: args.kind, body: args.body }),
  ),

  defineTool(
    {
      name: 'assign_task',
      title: 'Assign task',
      description: 'Point a card at an actor. The assignee must be a member of the board.',
      kind: 'write',
      annotations: WRITE,
      route: { method: 'POST', path: '/api/tasks/{task_id}/assign' },
      useCase: 'assignTask',
    },
    z.object({
      task_id: z.string().min(1),
      assignee_id: z.string().min(1).nullable(),
    }),
    (app, ctx, args) =>
      app.assignTask.execute({
        ...ctx,
        taskId: id<TaskId>(args.task_id),
        assigneeId: args.assignee_id === null ? null : id<ActorId>(args.assignee_id),
      }),
  ),

  defineTool(
    {
      name: 'set_blocked_by',
      title: 'Set blockers',
      description: 'Replace the blocker list. Refuses a dependency cycle before writing anything.',
      kind: 'write',
      annotations: WRITE,
      route: { method: 'POST', path: '/api/tasks/{task_id}/blockers' },
      useCase: 'setBlockedBy',
    },
    z.object({
      task_id: z.string().min(1),
      blockers: z.array(z.string()),
    }),
    (app, ctx, args) =>
      app.setBlockedBy.execute({
        ...ctx,
        taskId: id<TaskId>(args.task_id),
        blockers: args.blockers.map((b) => id<TaskId>(b)),
      }),
  ),

  defineTool(
    {
      name: 'escalate_task',
      title: 'Escalate to a human',
      description: 'The agent-to-human handoff: an escalation comment plus a human assignee, in one write. The target must be a human actor.',
      kind: 'write',
      annotations: WRITE,
      route: { method: 'POST', path: '/api/tasks/{task_id}/escalate' },
      useCase: 'escalate',
    },
    z.object({
      task_id: z.string().min(1),
      human_actor_id: z.string().min(1),
      note: z.string().min(1),
    }),
    (app, ctx, args) =>
      app.escalate.execute({
        ...ctx,
        taskId: id<TaskId>(args.task_id),
        humanActorId: id<ActorId>(args.human_actor_id),
        note: args.note,
      }),
  ),

  defineTool(
    {
      name: 'register_agent',
      title: 'Register a principal',
      description:
        'Put a principal on the board and mint its credential. Only a board admin may call this — an agent cannot create its own members. The credential is returned once and never read back, so this is the only operation that hands one out.',
      kind: 'write',
      annotations: WRITE,
      route: { method: 'POST', path: '/api/boards/{board_id}/agents' },
      useCase: 'registerAgent',
    },
    z.object({
      board_id: z.string().min(1),
      actor_id: z.string().min(1),
      name: z.string().min(1),
      type: z.enum(['human', 'agent']),
      role: z.enum(['viewer', 'member', 'admin', 'agent']),
      scopes: z.array(z.enum(['read', 'write', 'transition', 'comment'])).min(1),
    }),
    (app, ctx, args) =>
      app.registerAgent.execute({
        ...ctx,
        boardId: id<BoardId>(args.board_id),
        actorId: id<ActorId>(args.actor_id),
        name: args.name,
        type: args.type,
        role: args.role,
        scopes: args.scopes,
      }),
  ),
];
