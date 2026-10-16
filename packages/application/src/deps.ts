import type {
  ActivityRepository,
  ActorDirectory,
  ActorResolver,
  BoardRepository,
  Clock,
  EventPublisher,
  IdGenerator,
  TaskKeySequence,
  TaskRepository,
  UnitOfWork,
  WorkflowRepository,
} from '@agentboard/domain';

/** The only place the graph of dependencies is assembled (see src/main.ts). */
export interface Deps {
  uow: UnitOfWork;
  tasks: TaskRepository;
  boards: BoardRepository;
  workflows: WorkflowRepository;
  activity: ActivityRepository;
  keys: TaskKeySequence;
  publisher: EventPublisher;
  resolver: ActorResolver;
  directory: ActorDirectory;
  clock: Clock;
  ids: IdGenerator;
}
