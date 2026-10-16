import { z } from 'zod';
import { id, type ActorId, type BoardId, type StateId, type TaskId } from '@agentboard/shared';
import { defineTool, type ToolDefinition } from '../toolRegistry.js';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/**
 * The read half of the surface. Every one of these is a query on the application facade:
 * no tool here reads a repository, computes a policy, or formats a domain object. That is
 * what the contract test checks.
 */
export const READ_TOOLS: ToolDefinition[] = [
  defineTool(
    {
      name: 'who_am_i',
      title: 'Who am I',
      description: 'Resolve the token to an actor and show the boards they can see plus their role on each. Start here.',
      kind: 'read',
      annotations: READ,
      route: { method: 'GET', path: '/api/me' },
      useCase: 'whoAmI',
    },
    z.object({}),
    (app, ctx) => app.whoAmI.execute(ctx),
  ),

  defineTool(
    {
      name: 'get_board_snapshot',
      title: 'Board snapshot',
      description:
        'Columns with counts and cards, plus the workflow graph: which transitions exist, which states are human gates, and where the WIP limits are. An agent decides what it is allowed to do from this.',
      kind: 'read',
      annotations: READ,
      route: { method: 'GET', path: '/api/boards/{board_id}' },
      useCase: 'getBoardSnapshot',
    },
    z.object({ board_id: z.string().min(1) }),
    (app, ctx, args) => app.getBoardSnapshot.execute({ ...ctx, boardId: id<BoardId>(args.board_id) }),
  ),

  defineTool(
    {
      name: 'get_task',
      title: 'Task detail',
      description: 'One card: fields, acceptance criteria, comments, and recent activity. Comments carry the run that produced them.',
      kind: 'read',
      annotations: READ,
      route: { method: 'GET', path: '/api/tasks/{task_id}' },
      useCase: 'getTask',
    },
    z.object({
      task_id: z.string().min(1),
      activity_limit: z.number().int().min(1).max(100).optional(),
    }),
    (app, ctx, args) =>
      app.getTask.execute({
        ...ctx,
        taskId: id<TaskId>(args.task_id),
        ...(args.activity_limit !== undefined ? { activityLimit: args.activity_limit } : {}),
      }),
  ),

  defineTool(
    {
      name: 'get_activity',
      title: 'Audit trail',
      description: 'Append-only history for a task, or for a whole board. It is the record of who moved what and why.',
      kind: 'read',
      annotations: READ,
      route: { method: 'GET', path: '/api/boards/{board_id}/activity' },
      useCase: 'getActivity',
    },
    z.object({
      board_id: z.string().min(1),
      task_id: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    (app, ctx, args) =>
      app.getActivity.execute({
        ...ctx,
        boardId: id<BoardId>(args.board_id),
        ...(args.task_id !== undefined ? { taskId: id<TaskId>(args.task_id) } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      }),
  ),

  defineTool(
    {
      name: 'list_tasks',
      title: 'List tasks',
      description: 'Cards on a board, filtered by state, assignee, label, blocked-only or text, one page at a time.',
      kind: 'read',
      annotations: READ,
      route: { method: 'GET', path: '/api/boards/{board_id}/tasks' },
      useCase: 'listTasks',
    },
    z.object({
      board_id: z.string().min(1),
      status_id: z.string().min(1).optional(),
      assignee_id: z.string().min(1).optional(),
      label: z.string().min(1).optional(),
      only_blocked: z.boolean().optional(),
      query: z.string().min(1).optional(),
      cursor: z.string().nullable().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    (app, ctx, args) =>
      app.listTasks.execute({
        ...ctx,
        boardId: id<BoardId>(args.board_id),
        filter: {
          ...(args.status_id !== undefined ? { statusId: id<StateId>(args.status_id) } : {}),
          ...(args.assignee_id !== undefined ? { assigneeId: id<ActorId>(args.assignee_id) } : {}),
          ...(args.label !== undefined ? { label: args.label } : {}),
          ...(args.only_blocked !== undefined ? { onlyBlocked: args.only_blocked } : {}),
          ...(args.query !== undefined ? { query: args.query } : {}),
          ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        },
      }),
  ),

  defineTool(
    {
      name: 'list_agents',
      title: 'The roster',
      description:
        'The board as a list of principals: who they are, who minted their credential, and which cards each is holding under a live lease at the moment of the read. Lease status is the server\'s answer, not a guess.',
      kind: 'read',
      annotations: READ,
      route: { method: 'GET', path: '/api/boards/{board_id}/agents' },
      useCase: 'listAgents',
    },
    z.object({ board_id: z.string().min(1) }),
    (app, ctx, args) => app.listAgents.execute({ ...ctx, boardId: id<BoardId>(args.board_id) }),
  ),
];
