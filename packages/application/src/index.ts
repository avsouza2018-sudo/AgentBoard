import type { Deps } from './deps.js';
import { Authorizer } from './services/authorizer.js';
import { GuardEvaluator } from './services/guardEvaluator.js';
import { LeaseManager } from './services/leaseManager.js';
import { Recorder } from './services/recorder.js';

import { CreateTask } from './commands/createTask.js';
import { MoveTask } from './commands/moveTask.js';
import { ClaimTask } from './commands/claimTask.js';
import { ReleaseTask } from './commands/releaseTask.js';
import { RenewLease } from './commands/renewLease.js';
import { AddComment } from './commands/addComment.js';
import { AssignTask } from './commands/assignTask.js';
import { SetBlockedBy } from './commands/setBlockedBy.js';
import { UpdateTask } from './commands/updateTask.js';
import { Escalate } from './commands/escalate.js';

import { GetBoardSnapshot } from './queries/getBoardSnapshot.js';
import { GetTask } from './queries/getTask.js';
import { GetActivity } from './queries/getActivity.js';
import { ListTasks } from './queries/listTasks.js';
import { WhoAmI } from './queries/whoAmI.js';

/**
 * The single facade both adapters use. `mcp` and `api` construct it from the same Deps and
 * call the same methods — that is what keeps the tool surface and the HTTP surface honest.
 */
export function buildApplication(deps: Deps) {
  const authorizer = new Authorizer(deps.resolver);
  const recorder = new Recorder(deps.activity, deps.publisher, deps.ids);
  const guards = new GuardEvaluator(deps.tasks, deps.workflows, deps.boards, deps.clock);
  const leases = new LeaseManager(deps.clock, deps.ids);

  return {
    createTask: new CreateTask(deps, authorizer, recorder),
    updateTask: new UpdateTask(deps, authorizer, recorder),
    moveTask: new MoveTask(deps, authorizer, guards, recorder),
    claimTask: new ClaimTask(deps, authorizer, guards, leases, recorder),
    releaseTask: new ReleaseTask(deps, authorizer, leases, recorder),
    renewLease: new RenewLease(deps, authorizer, leases, recorder),
    addComment: new AddComment(deps, authorizer, recorder),
    assignTask: new AssignTask(deps, authorizer, recorder),
    setBlockedBy: new SetBlockedBy(deps, authorizer, recorder),
    escalate: new Escalate(deps, authorizer, recorder),

    whoAmI: new WhoAmI(deps, authorizer),
    getBoardSnapshot: new GetBoardSnapshot(deps, authorizer),
    getTask: new GetTask(deps, authorizer),
    getActivity: new GetActivity(deps, authorizer),
    listTasks: new ListTasks(deps, authorizer),
  };
}

export type Application = ReturnType<typeof buildApplication>;

export * from './deps.js';
export * from './context.js';
export * from './commands/createTask.js';
export * from './commands/moveTask.js';
export * from './commands/claimTask.js';
export * from './commands/releaseTask.js';
export * from './commands/renewLease.js';
export * from './commands/addComment.js';
export * from './commands/assignTask.js';
export * from './commands/setBlockedBy.js';
export * from './commands/updateTask.js';
export * from './commands/escalate.js';
export * from './queries/getBoardSnapshot.js';
export * from './queries/getTask.js';
export * from './queries/getActivity.js';
export * from './queries/listTasks.js';
export * from './queries/whoAmI.js';
export * from './queries/map.js';
export * from './services/authorizer.js';
export * from './services/guardEvaluator.js';
export * from './services/leaseManager.js';
export * from './services/recorder.js';
export * from './services/graph.js';
