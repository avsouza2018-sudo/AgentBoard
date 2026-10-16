import type {
  ActivityRepository,
  ActorDirectory,
  ActorRegistry,
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
  /** The roster of principals. A port, so the command that grants membership does not know what a
   * token looks like or how it is stored. */
  agents: ActorRegistry;
  clock: Clock;
  ids: IdGenerator;
}
