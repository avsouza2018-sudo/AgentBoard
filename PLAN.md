# AgentBoard — a JIRA-like board for AI agents, driven through MCP

**Stack:** TypeScript (ESM, strict), Node 20+, React + Vite, PostgreSQL, `@modelcontextprotocol/sdk`, Fastify.
**Layout:** pnpm workspace monorepo.
**Auth:** per-agent bearer tokens mapped to an `Actor` principal.
**MCP transports:** Streamable HTTP (remote agents) + stdio (local clients), sharing the same tool handlers.

---

## 1. What we are actually building

A task board whose primary "users" are agents. The board is the shared memory + work queue for a fleet: agents claim tasks, move them across columns, comment with results, get blocked, and hand off to humans or other agents.

The JIRA skeleton (boards, columns, cards, transitions, audit trail) is the container. The **AI-native delta** is what makes it worth building:

| JIRA concept | AgentBoard equivalent |
|---|---|
| User | `Actor` (human or agent), first-class, same permission model |
| Assignee | Assignee + **Lease** (an agent actively holds the task while running) |
| Transition | Transition with **guards** (WIP limits, required fields, human-gate states) |
| Activity log | Append-only, attributable, machine-readable events |
| Comment | Comment with typed `kind` (result, question, handoff, escalation) |
| Reporter | `provenance`: which actor + which run created the change |
| Automation rules | Workflow guards evaluated by the domain, not by UI code |

The one rule that keeps this clean: **MCP tools and HTTP routes are both thin adapters over the same application services.** No business logic lives in the MCP layer, the HTTP layer, or the React layer.

---

## 2. v1 scope

**In:** boards, workflows (states + transitions + guards), tasks, labels, dependencies (`blockedBy`), comments, activity/audit, agent tokens, leases, WIP limits, board snapshot read model, MCP tool surface, React board (columns + card + detail drawer + activity feed + live updates).

**Out (v1):** notifications, email, reporting dashboards, multi-tenancy billing, custom fields UI, import from JIRA, webhooks, search beyond filter+full-text, retention policies.

---

## 3. Architecture

### Dependency rule (enforced, not aspirational)

```
        ┌─────────────────────────────────────────────┐
        │  main (composition root)                    │
        └───────────────┬─────────────────────────────┘
                        │ wires
   ┌────────────────────┼──────────────────────────┐
   │ adapters           │                          │
   │ http, mcp, react   │                          │
   └──────────┬─────────┘                          │
              │ calls                              │
        ┌─────┴───────────┐      ┌────────────────┴──────┐
        │ application     │─────▶│ ports (interfaces)    │
        │ (use cases)     │      └───────────────────────┘
        └─────┬───────────┘              ▲ implemented by adapters
              │ depends on               │
        ┌─────┴───────────┐              │
        │ domain          │              │
        │ (entities,      │──────────────┘ (domain defines the ports)
        │  policies)      │
        └─────────────────┘
```

Domain imports nothing. Application imports domain + ports. Adapters import application + ports. React is a separate client that consumes the HTTP contract only.

Enforcement: `dependency-cruiser` in CI (`domain` may not import `fs`, `pg`, `http`, `express`, `zod`, or any adapter).

### Monorepo layout

```
agentboard/
  pnpm-workspace.yaml
  package.json                 # root scripts: dev, build, test, lint, dep-check
  packages/
    shared/                    # Result/Either, error taxonomy, ids, zod-free DTO contracts
      src/
        result.ts              # Ok/Err, typed failure union
        errors.ts              # DomainError | ValidationError | PermissionError | ConcurrencyError | NotFoundError
        ids.ts                 # ActorId, BoardId, TaskId, RunId (branded string types)
        contracts/             # request/response shapes shared by api + mcp + web
    domain/                    # pure, no framework, no I/O
      src/
        model/                 # Board, Task, Workflow, Comment, ActivityEvent, Actor, Lease
        policy/                # canTransition, wipLimit, leaseOwnership, requiredFieldsForState
        ports/                 # TaskRepository, BoardRepository, WorkflowRepository,
                               # ActivityRepository, UnitOfWork, Clock, IdGenerator,
                               # TaskKeySequence, EventPublisher, ActorResolver,
                               # ActorDirectory
        events/                # TaskMoved, TaskCreated, TaskBlocked, LeaseExpired
    application/               # use cases = one class per operation
      src/
        commands/              # CreateTask, MoveTask, AssignTask, ClaimTask, ReleaseTask,
                               # AddComment, SetBlockedBy, UpdateTask, RequestHumanGate
        queries/               # GetBoardSnapshot, ListTasks, GetTask, SearchTasks, GetActivity
        services/              # Authorizer, LeaseManager, GuardEvaluator
    infra/
      src/
        postgres/              # repositories, migrations, optimistic locking, outbox
        events/                # in-process bus + SSE publisher adapter
        security/              # token verification -> ActorResolver
        config/                # env parsing (zod), only place env is read
    mcp/
      src/
        server.ts              # builds McpServer from tool definitions
        tools/                 # one file per tool: zod schema + handler -> use case
        transports/            # stdio.ts, http.ts
    api/
      src/
        server.ts              # Fastify app factory (takes use cases, not globals)
        routes/                # thin: parse DTO -> call use case -> map error to status
        realtime/              # SSE endpoint
  apps/
    web/                       # React + Vite
  db/                          # migrations (plain SQL files, numbered)
  tests/                       # cross-package integration + e2e
```

### Application service shape (the seam that keeps MCP and HTTP honest)

```ts
// application/commands/MoveTask.ts
export class MoveTask {
  constructor(
    private uow: UnitOfWork,
    private tasks: TaskRepository,
    private workflows: WorkflowRepository,
    private guards: GuardEvaluator,
    private clock: Clock,
    private bus: EventPublisher,
  ) {}

  async execute(input: MoveTaskInput): Promise<Result<Task, ApplicationError>> {
    const actor = await this.guards.resolveActor(input.actorToken);      // port, not middleware
    return this.uow.withTransaction(async (tx) => {
      const task = await this.tasks.findById(tx, input.taskId);
      if (!task) return err(new NotFoundError('task', input.taskId));

      const wf = await this.workflows.findByBoard(tx, task.boardId);
      const decision = task.evaluateTransition(wf, input.toState, actor, this.clock.now()); // domain policy
      if (!decision.ok) return err(decision.failure);

      task.applyTransition(decision.transition, actor, this.clock.now());  // emits domain event
      await this.tasks.save(tx, task);                                    // version-checked
      const event = task.pullEvents()[0];
      await this.activity.append(tx, ActivityEvent.from(event, actor, input.provenance));
      await this.bus.publish(tx, event);
      return ok(task);
    });
  }
}
```

`mcp/tools/move_task.ts` and `api/routes/moveTask.ts` both call `moveTask.execute(...)` with the same input type. The MCP layer adds only: schema validation, JSON rendering, and tool annotations (`readOnlyHint`, `destructiveHint`).

---

## 4. Domain model

### Aggregates

- **Board** — id, name, `workflowId`, members (`ActorId` + role), settings. Root of the workspace boundary.
- **Workflow** — states (with `category`: todo / in_progress / done, `isHumanGate`), transitions `(from, to, name, guards, allowedRoles)`, column order, WIP limit. Per board.
- **Task** (aggregate root) — `id`, `boardId`, `key` (`AG-123`), `title`, `description`, `statusId`, `priority`, `assigneeId`, `reporterId`, `labels`, `blockedBy[]`, `acceptanceCriteria[]`, `agentMeta` (`runId`, `attempt`, `costHint`), `lease`, `version`, timestamps.
- **Lease** — active work claim: `taskId`, `agentId`, `acquiredAt`, `expiresAt`, `renewCount`. Distinct from assignment: an agent can be assigned without holding the lease, and a lease can be held without being the assignee.
- **Comment** — `kind`: `result | question | handoff | escalation | note`, `authorId`, `runId`, body, `taskId`.
- **ActivityEvent** — append-only, immutable, attributable. Never mutated.
- **AgentRegistration** — name, token hash, scopes (`read`, `write`, `transition`, `comment`), status.

### Invariants (domain-enforced, not UI-enforced)

1. A task can only move along an existing transition in its board's workflow.
2. A transition may require: labels present, acceptance criteria non-empty, `blockedBy` empty, or a human-gate approval (`isHumanGate` states cannot be entered by an agent token).
3. WIP limit: entering a state with `wipLimit` fails with `WipLimitError` naming the offending task.
4. A task with open `blockedBy` cannot enter `in_progress` unless the blocker is done or the actor explicitly sets `forceReason` (audited).
5. Lease ownership: only the lease holder may write the `result` comment or complete the task; expired leases release automatically via `LeaseExpired` event.
6. Optimistic concurrency: `Task.version` — a write with a stale version fails with `ConcurrencyError` including the current version so agents can re-read.
7. Task key generation is board-scoped and monotonic; keys are never reused (sequence table).

### Domain policies as pure functions

```ts
// domain/policy/canTransition.ts
export function canTransition(task, wf, toState, actor, now): TransitionDecision
// composes: transitionExists, roleAllowed, guards, wipLimit, blockedBy, humanGate, leaseOwnership
```

Pure, deterministic, takes a `Clock` value rather than calling `Date.now()` — so tests are exact.

---

## 5. MCP tool surface

Every tool maps 1:1 to a use case. `readOnly` tools get `readOnlyHint: true`; mutating tools get `destructiveHint: true` so client-side approval UX works.

| Tool | Use case | Notes |
|---|---|---|
| `whoami` | ResolveActor | returns actor identity, scopes, boards visible |
| `list_boards` | GetBoardSnapshot (lite) | |
| `get_board` | GetBoardSnapshot | columns, WIP limits, workflow graph |
| `list_tasks` | ListTasks | filters: board, status, assignee, label, blocked, query; cursor pagination |
| `get_task` | GetTask | includes comments + last 20 activity events |
| `create_task` | CreateTask | `key` auto-generated |
| `update_task` | UpdateTask | title/desc/priority/labels; `expectedVersion` optional |
| `move_task` | MoveTask | `from` → `to`, `reason` required for audit |
| `claim_task` | ClaimTask | acquires lease, auto-assigns, moves to `in_progress` if allowed |
| `release_task` | ReleaseTask | drops lease, optionally unassigns |
| `renew_lease` | RenewLease | heartbeat for long-running agents |
| `add_comment` | AddComment | typed kind; `result` kind requires lease |
| `set_blocked_by` | SetBlockedBy | edges + cycle detection |
| `mark_done` | MoveTask shortcut | guarded transition to a `done` category state |
| `escalate` | AddComment(kind=escalation) + AssignTask(human) | the agent→human handoff primitive |
| `get_activity` | GetActivity | audit read for a task or board |

Tool response envelope (stable, machine-friendly):

```json
{ "ok": true, "data": { "task": { "id": "...", "key": "AG-123", "status": "in_progress", "version": 7 } },
  "meta": { "actor": { "id": "agent:x", "type": "agent" }, "cursor": null } }
```

Failure envelope:

```json
{ "ok": false, "error": { "code": "wip_limit", "message": "in_progress is full (limit 3)",
  "details": { "state": "in_progress", "limit": 3, "occupants": ["AG-118"] }, "retryable": false } }
```

Error codes are the shared taxonomy in `packages/shared/errors.ts` — HTTP maps them to status codes, MCP returns them as `isError` content with the same code. Same source of truth.

Two transports, one tool registry:

- `mcp/src/server.ts` builds `McpServer` and registers the tool definitions once.
- `stdio` entry (`bin/agentboard-mcp`) for local clients.
- Streamable HTTP entry mounted inside the Fastify app at `/mcp` with bearer token auth.

---

## 6. HTTP API (what React consumes)

```
POST   /api/agents/register            -> token (one-time reveal)
GET    /api/boards
GET    /api/boards/:boardId/snapshot    -> columns + cards + counts
GET    /api/tasks?board&status&assignee&label&q&cursor
POST   /api/tasks
GET    /api/tasks/:id
PATCH  /api/tasks/:id
POST   /api/tasks/:id/move
POST   /api/tasks/:id/claim | /release | /renew
POST   /api/tasks/:id/comments
POST   /api/tasks/:id/blocked-by
GET    /api/tasks/:id/activity
GET    /api/events (SSE)                -> board-scoped live stream
GET    /api/health, /api/metrics
```

Auth: `Authorization: Bearer <token>` → `ActorResolver` → injected as `actor` into every use case call. React uses a human session token; agents use agent tokens. Both resolve to the same `Actor` abstraction, so permissions are one code path.

---

## 7. Event flow and realtime

```
use case → domain event → ActivityEvent (append, in same tx)
                        → outbox row (same tx)
                        → EventPublisher → bus → SSE → React
```

The outbox is written inside the same transaction as the aggregate change; a dispatcher drains it after commit. This is the only way to guarantee "the audit log and the live board agree" without distributed transactions.

React subscribes to SSE, applies events to the TanStack Query cache by `taskId`, and reconciles with the snapshot query on reconnect (resumable via `last_event_id`).

---

## 8. Frontend

- **Vite + React + TypeScript**, TanStack Query + Router, no UI framework lock-in.
- Feature slices: `board/` (columns, card, swimlanes), `task/` (detail drawer, comments, activity), `agents/` (registry, activity feed), `filters/`.
- Components are presentational; data access lives in a thin client layer generated from `packages/shared/contracts`.
- **No domain rules in the UI.** The UI renders the workflow graph it fetched; it does not hardcode which transitions are allowed. Guard failures come back from the server and are rendered as reasons.
- Optimistic move with rollback on `ConcurrencyError` (re-fetch and show "someone else moved this card").
- Board view: columns from workflow states, WIP badges, agent avatars with live/lease indicator, filter chips, keyboard move.
- Task drawer: acceptance criteria, blockers, comments by kind, activity timeline, version.
- Agent panel: which agents are connected, current lease, last action, per-agent throughput.

---

## 9. Testing strategy

| Layer | Test | Tool |
|---|---|---|
| domain | policy tests (transition guards, WIP, lease, human gate) | vitest, no mocks needed |
| application | use cases against in-memory fake ports | vitest |
| infra | repository round-trips, optimistic locking, outbox | vitest + testcontainers |
| mcp | tool schema + handler contract (same use case as HTTP) | vitest, in-process client |
| api | route → error-code mapping, auth | supertest |
| web | component + optimistic update behavior | vitest + testing-library |
| e2e | "agent claims → moves → comments; human sees card move live" | Playwright + real MCP client |

Definition of done for the architecture: `pnpm dep-check` fails if `packages/domain` imports anything outside itself, and the MCP and HTTP paths are proven to reach the same use case in the contract test.

---

## 10. Milestones

| # | Deliverable | Acceptance criteria |
|---|---|---|
| **M0** | Workspace scaffold | pnpm workspaces, tsconfig strict, vitest, dependency-cruiser rules, shared error taxonomy, `pnpm dep-check` green |
| **M1** | Domain core | Board/Workflow/Task/Actor/Comment/Activity models + policies; policy tests green (transition, WIP, human gate, blockedBy, version) |
| **M2** | Application + fakes | commands + queries against in-memory ports; use-case tests green; no `fs`/`pg` import anywhere in app or domain |
| **M3** | Postgres adapter + migrations | repositories, `Task.version` CAS, outbox, key sequence; integration tests green |
| **M4** | MCP server ✅ | stdio + HTTP transports, full tool surface, error-code parity with HTTP; agent can claim → move → comment end-to-end |
| **M5** | HTTP API + auth ✅ | routes generated from the tool registry, token auth, actor resolution, error mapping, SSE from the outbox, OpenAPI from the same definitions |
| **M6** | React board ✅ | columns, card move, drawer, activity, live updates, optimistic rollback |
| **M7** | Agent panel + hardening ✅ | agent registry (who minted this credential), `canRegisterPrincipal`, lease status as a domain word, per-token rate limit in an adapter, structured logging, fleet strip on the page, README example agent session |

---

## 11. Decisions to lock before coding

1. **Idempotency:** agent writes accept an optional `idempotencyKey`; duplicate retries return the original result instead of double-applying a transition.
2. **Rate limiting:** per-token, enforced in an adapter (not the domain), with `retryable: true` + `retryAfter`.
3. **Human-gate states** are a first-class workflow property, not a role hack — this is the safety story for agents on the board.
4. **Attribution is mandatory:** every write carries `actor` + `provenance` (`runId`), so the audit log answers "who moved this card and why".
5. **No ORM** in the domain. Repositories return domain entities; SQL row types stay in `infra`.
6. **Ports live in `domain/ports`** so the dependency rule holds; adapters implement them.
7. **CQRS-lite:** commands mutate aggregates, queries read read-models; both in `application`, no framework.

---

## 12. Risks

- **MCP tool drift** (tool logic diverging from HTTP) — mitigated by the shared application facade + contract test.
- **Lease storms** from many agents — mitigated by lease expiry, renewal heartbeats, and claim conflicts returning `ConcurrencyError` with the current holder.
- **Guard complexity** — mitigated by keeping guards as pure composable policy functions with a decision object that explains *why* a move failed.
- **Schema churn** — migrations are numbered SQL files, no runtime auto-sync.

---

## 13. Build status — M0, M1, M2, M3, M4, M5, M6, M7 complete

`pnpm typecheck` clean (both tsconfigs), 120 tests green, `pnpm dep-check` exit 0 (117 modules, 243 dependencies).

| Milestone | State |
|---|---|
| M0 scaffold | done — pnpm workspaces, strict tsconfig, vitest, dependency-cruiser rules, shared `Result`/error taxonomy, branded ids |
| M1 domain core | done — `Task`, `Board`, `Workflow`, `Actor`, `Comment`, `Lease`, `ActivityEvent`, pure `evaluateTransition` + `canComment`; 12 policy tests |
| M2 application + fakes | done — 10 commands, 5 queries, in-memory adapters; 14 use-case tests + an end-to-end story test |
| M3 Postgres adapter | done — numbered SQL migrations + runner, `PgUnitOfWork`, repositories implementing the domain ports, CAS, outbox with `SKIP LOCKED` drain, key sequence, 10 integration tests + a parity test against the in-memory fakes |
| M4 MCP server | done — transport-neutral tool registry (15 tools, one per use case), JSON-schema contract snapshot, stdio + stateless streamable-HTTP transports, error-code parity, 21 tests including a real child-process stdio run |
| M5 HTTP API | done — routes generated from the tool definitions, token auth through the same `ActorResolver`, error mapping through the same table, SSE fed by the outbox, OpenAPI generated from the same definitions; 17 tests (9 REST, 4 SSE, 4 OpenAPI) |
| M6 React board | done — the page is a client of the HTTP contract: hand-written mirror shapes checked against a live server, an optimistic store whose rollback re-reads the server, a live feed fed by the outbox, columns + card + drawer + activity; 12 tests (6 board, 6 client) |
| M7 agent panel + hardening | done — registry port + `canRegisterPrincipal` (the fleet cannot mint a credential), attribution stored on the credential row, `Board.grant` + `save`, lease status as a domain word reported by the read model, per-token token bucket in the shared registry (refused before the use case runs, 429 + `retry-after`, same words over both doors), one structured log entry per call that names the actor and never the credential, fleet strip on the page, README example agent session; 30 new tests (7 policy, 6 registry, 5 rate limit, 6 logging, 6 web agents) plus refreshed assertions in the contract, client, stdio and migration tests — 120 in total |

### What M0–M2 forced

1. **Guard order is a decision, not an accident.** See item 1 under M3 — the code and its own
   comment disagreed, and the ordering only matters when two guards fail at once.
2. **Policy before mutation.** `ClaimTask` evaluates the guard before acquiring the lease, so a
   rejected claim does not leave a half-applied transition. The in-memory repository stores
   snapshots rather than live references, which makes optimistic concurrency genuinely
   observable in tests rather than implied.
3. **`ActorResolver` and `ActorDirectory` are two ports.** "Who is calling?" and "who are we
   handing this to?" are different questions; conflating them made escalation resolve an actor
   id as a bearer token. Now separate.

Claim conflict returns `LeaseConflictError` (code `conflict`) with the current holder and expiry,
rather than a generic concurrency error — an agent needs to know who holds the card and when the
lease lapses, not just that it lost a race.

### What M3 forced

1. **The guard order, settled.** The comment in `evaluateTransition` said completeness came before
   the role gate, but the code checked the role first, and the tests never exercised the case where
   both fail. The code is right and the comment was wrong: if a caller cannot run the transition at
   all, telling it to fill in a field is not actionable. Order is now graph → role → completeness →
   human gate → blockers → lease → WIP, with a test for the both-fail case.
2. **An opaque `Tx` needs a connection on the Postgres side.** The domain port passes `Tx` as an
   opaque handle, so `PgTx` carries a `PoolClient` and the repositories resolve it. Pairing a
   Postgres repository with `MemoryUnitOfWork` is a wiring mistake that would otherwise write to
   the wrong store silently; it now fails with a message naming the mismatch.
3. **Rollback only fires on a throw, and that is safe only because of the guard order.** Commands
   return `Result` instead of throwing, so an unsuccessful command never opens a write. The
   transaction's correctness depends on policy running before mutation — the M2 decision is what
   makes the M3 transaction honest.
4. **A Postgres `SEQUENCE` would break the promise the domain makes.** `TaskKeySequence` says
   "monotonic, never reused". A sequence advances even when the transaction that took the number
   rolls back, leaving `AG-7` attached to a task that does not exist. It is a row updated inside the
   transaction instead, so a rolled-back key is not burned.
5. **Append-only is enforced in the database, not by convention.** A trigger raises on
   `UPDATE`/`DELETE` of `activity_events`. The domain rule and the storage rule now agree.
6. **The outbox id cannot be the aggregate id.** One task produces many events, so the adapter
   generates the id; the domain port hands the event without one. Drain runs after commit on a
   separate connection with `FOR UPDATE SKIP LOCKED`, so two dispatchers never claim the same row.
7. **The migration runner owns its own bookkeeping.** It cannot depend on a table created by a
   migration, so `schema_migrations` is created by the runner, not by `001_initial.sql`.
8. **The dependency rule needed one explicit carve-out.** `dependency-cruiser` resolves `node:fs`
   to `fs`, so the adapters rule had to list core modules by name. Domain remains strict — verified
   by planting a probe that imports `node:fs` in `packages/domain` and watching it fail.

### The test that matters most in M3

`tests/infra/parity.test.ts` runs one scenario against both storage implementations and compares
the audit trail including event ids and timestamps. That only lines up if the ports really are
interchangeable, which is the claim the architecture rests on. The in-memory fakes are not a
convenience: they are the specification the Postgres adapter is measured against.

### What M4 forced

1. **The registry is the surface; the transports are shells.** `tools/list` is produced by iterating
   the definitions, so stdio and HTTP cannot present different tools. A transport that registered
   its own copy of a tool would show up as a mismatch in the test that compares the two.
2. **A tool has to route, not implement.** The contract test drives all 15 tools against a facade
   that records which use case was called. That is the only way to prove "the tool calls its use
   case" without duplicating tool logic in the test — and it turns `useCase` from documentation
   into a fact the build enforces.
3. **A domain aggregate is not a JSON record.** Commands return `Task`, a class instance holding
   `Date`s. MCP `structuredContent` has to be a JSON object, and the SDK validator rejected the
   aggregate. The adapter serialises. The domain shape and the wire shape are different things, and
   pretending they are the same is what makes a client reject a perfectly valid result.
4. **Provenance is enforced in the layer the two transports share.** An agent write with no run id is
   refused before any use case runs. Enforcing it inside an MCP handler would have made HTTP
   permissive for the same write.
5. **Stateless is the honest default for an identity-bearing endpoint.** A session that outlives a
   request can inherit another agent's token, so the HTTP transport binds the context to the
   request. The transport does not authenticate: it hands the bearer token to the same
   `ActorResolver` the application uses, so "unknown token" has exactly one answer everywhere.
6. **Annotations are promises, and the false ones were dropped.** Every write tool carries
   `idempotentHint: false`, because a second identical call really does change the board — version
   bump plus an activity event. Setting it to `true` would have been a lie about retry semantics.
7. **The guard order showed up in a failing test here too.** A human-gate scenario first returned
   `validation`, because completeness runs before the human gate and the fixture card had no
   acceptance criteria. The test had to fill the field to exercise the guard it claimed to test.
8. **`exactOptionalPropertyTypes` and the SDK disagree about `sessionId`.** The SDK's `Transport`
   declares it as `string`; a stateless transport has none. One documented cast in the transport,
   not a widening of the compiler settings.
9. **External packages needed a different mechanism in the dependency rule.** `to.not: { external }`
   is not a valid criterion; `dependencyTypesNot` is. pnpm's symlinked store makes the MCP SDK
   unresolvable, so it is classified `unknown` and the transport rule lists it — while `domain` and
   `application` keep external imports forbidden, which is what stops zod from creeping inward. The
   rule was renamed `storage-adapters-point-inward-only` and paired with
   `composition-root-wires-everything`; planting an import of `@agentboard/infra` in
   `packages/adapters` fires the new rule.

### The test that matters most in M4

`tests/adapters/contract.test.ts` calls every tool through the registry against a facade that
records which use case ran, and asserts it is exactly the one the contract names — with the actor
token and the run id forwarded, not re-derived. As the surface grows from 15 tools to 30, this is
the test that keeps a tool from quietly growing its own logic. `tests/adapters/stdio.test.ts` is the
one that proves the transport is real: it spawns the entrypoint as a child process and talks to it
over a pipe, which is how every MCP client actually starts the server.

### What M5 forced

1. **A route is a fact about the tool, not a description beside it.** Each definition carries its
   own `route`, the contract snapshot now includes it, and the router is built from the definitions.
   A path that reads an argument the tool does not accept fails at build time. Without this, the
   REST surface and the MCP surface are two descriptions of the same thing, which is exactly how
   they drift.
2. **405 needed a code the taxonomy did not have.** `method_not_allowed` is the first code produced
   by an adapter rather than by the domain: the router knows the path exists but not under the
   method used. It goes through the same `HTTP_STATUS` table, so the HTTP surface still has no error
   shape of its own. A path that is not in the table is 404; that distinction is only possible
   because the match is (method, path), not path alone.
3. **The path is authoritative over the body.** A client that names `task_id` in both the URL and
   the JSON body has to get one answer. The URL wins, because the URL is what the router was asked
   about. Two sources of truth for the same argument is the bug, not the disagreement.
4. **A query string is all strings, so coercion has to come from the schema.** The router reads the
   JSON-schema node from the same definitions and passes an un-coercible value through unchanged, so
   the schema produces the validation error. The adapter never decides what an invalid number is.
5. **A stream fed by an in-process hook announces things that never happened.** A hook fires before
   the transaction commits. The SSE stream reads the outbox after commit instead, and the test proves
   the gate rather than asserting it: a write appends a row, nothing is delivered, then the
   post-commit dispatch delivers exactly one frame.
6. **A row is delivered once.** Drain semantics mean a second dispatch delivers nothing — which is
   the same property `SKIP LOCKED` gives the Postgres dispatcher.
7. **The stream authorises through the facade.** It asks the same query an agent calls (`whoAmI`)
   which boards this token can see. An adapter that decided visibility by itself would be a second
   authorisation rule, and the two would drift the first time a role changed.
8. **The outbox is one object with two callers, and only the composition root is allowed to know
   that.** The application is handed a publisher; the stream needs a reader. The domain port says
   nothing about draining, because the application never drains — so the root wires the same instance
   to both, and that is the only place the fact exists.
9. **`pnpm dep-check` was not failing the build.** With `--output-type text` dependency-cruiser prints
   the graph and exits 0 even with an error-severity violation. The default `err` reporter is what
   makes the exit code mean something. Verified both ways: planted an import of `@agentboard/infra`
   in `packages/adapters/src/http/router.ts` → exit 1; removed → exit 0. The honest limit: a
   specifier dependency-cruiser cannot resolve is classified `unknown` and passes, so the rule catches
   cross-package imports resolved through tsconfig paths, not every path a human could write.
10. **An OpenAPI path has to accumulate methods.** `GET /api/tasks/{task_id}` and
    `POST /api/tasks/{task_id}` are two tools on one path; assigning `paths[path] = { method: op }`
    silently dropped the first one. The test that compares the document with the route table caught it.

### The test that matters most in M5

`tests/adapters/rest.test.ts` drives the same tool twice: once through a route, once through the
protocol, against the same registry. The results have to be the same object, and the failure has to
carry the status the same table gives that code. That is the only test that can catch the drift the
architecture exists to prevent — a REST handler that validates differently, authorises differently,
or classifies an error differently from the tool an agent calls. `tests/adapters/sse.test.ts` is the
one that proves the stream is honest: nothing is delivered before the post-commit dispatch, so a
frame is a row a committed transaction wrote.


### What M6 forced

1. **The page is a client of the contract, not a consumer of the domain.** `apps/web` imports React
   and its own files. The mirror shapes in `apps/web/src/contract.ts` are hand-written, and a type
   cannot be checked at runtime — so the field lists are exported as values and the client test
   compares them against the JSON a live server actually sends. That is what keeps a hand-written
   mirror honest.
2. **A write returns the aggregate, and the aggregate had a private field on the wire.** `private` is
   a compile-time word: `JSON.stringify` sent `pendingEvents`, so the client mirror was short one
   field and the contract was quietly wider than it looked. `Task` now names its own wire shape. The
   field it drops is internal state that is empty by the time anything reads it — the problem was not
   the value, it was that a client could build on it.
3. **Rollback means re-reading, not undoing.** A card that moved optimistically can be moved by
   someone else between the click and the refusal. Restoring the pre-click picture would restore a
   guess. On success the store adopts the response, because the response is the aggregate a committed
   transaction wrote; on refusal it re-reads the board, because its guess was wrong and something else
   may have happened in between.
4. **The UI does not decide legality.** It renders the workflow graph as the snapshot described it and
   asks. Filtering the transitions by role in the page would be a second copy of the guard, and the
   copy in the browser is the one that drifts. A button you are not allowed to use answers with the
   domain's own sentence, shown on the card that caused it.
5. **A live frame cannot overwrite a card that is in flight.** The frame is a committed fact, so it is
   recorded; the card still belongs to the call that has not come back. Two different promises, and
   the store has to keep both.
6. **The client does not classify.** It hands over the `code` the server chose. The only value it
   produces itself is `no_error_body`, and that is a statement about the transport, not a domain code
   — it means the server did not answer with the documented shape.
7. **A store has to mutate what it stored, not what it renders.** The first version mutated the view
   copy and the next paint lost the change. The stored task is the fact; the view is a computation
   over it.
8. **A test gate that holds every request measures the gate, not the rollback.** The gate had to hold
   only writes, because a refusal triggers a re-read — and a gate that holds the re-read never
   releases. Three tests hung for 60 seconds before that was visible.
9. **The dependency rule gained a client.** `web-consumes-the-contract-only` fails the build if
   `apps/web` imports a package. Verified: planting `import { id } from '@agentboard/shared'` in
   `apps/web/src/contract.ts` → exit 1; removed → exit 0.

### The test that matters most in M6

`tests/web/board.test.ts` — the page asks for a column the graph does not connect, another actor moves
the same card while the call is in flight, and after the refusal the card is where the server says it
is, not where the page thought it was. That is the only test that can tell an optimistic UI from a
lying one. `tests/web/client.test.ts` is the pair: it checks every operation the client calls against
the generated OpenAPI document, and compares the field lists the client expects against the JSON a live
server sends. A page that invents a route or drifts from the response shape is caught there.

### What M7 forced

1. **The fleet cannot create its own members.** `canRegisterPrincipal` is a pure policy: only a board
   admin may mint a credential, and the refusal names the role it needs. A registry that lets an agent
   register itself is not a registry — it is an open door, and every audit row after it has no author.
   An agent with write scope could otherwise mint a second agent with a broader role, and the trail would
   show a card moved by someone who was granted nothing.
2. **The domain must not know what a credential looks like.** `ActorRegistry` returns an opaque handle:
   the memory adapter mints `tok-<actorId>` so the demo board is reproducible, Postgres mints a uuid. A
   rule written against either format would pass in a test and fail in production — so the harness seeds
   its fixture tokens directly instead of calling the port.
3. **Attribution lives on the credential row, not in the audit log.** `ActivityEvent.taskId` is required:
   the audit trail is aggregate-scoped, so a board-level registration cannot be appended to it. The token
   row carries `created_by`, `run_id`, `registered_at`, and `registeredBy` is `null` for exactly one row —
   the seed, the credential nobody minted. If `null` could also mean "not recorded", the trail stops being
   readable.
4. **Membership is aggregate behaviour.** `Board.grant` + `BoardRepository.save`. A rule that lives in a
   repository is a rule the read path can bypass.
5. **The log names the actor, never the credential.** A token is an input and a secret; putting it in a log
   line puts the proof of identity somewhere it is copied, retained, and read by people who were not the
   caller. `actorId` answers the same question without carrying the thing that proves it. The resolver is
   called once at the boundary for the log, and again by the use case through `Authorizer` — same port,
   two questions.
6. **Exactly one entry per call, whatever the outcome**, produced by the registry both transports share.
   A log that only records successes cannot answer what went wrong, and the refused call is the one a
   reader is looking for — so the rate limit writes its own record, with `limited: true`, before anything
   ran. The `route` in the entry comes from the tool definition, not from the request: the same reason
   OpenAPI is generated rather than written beside the routes.
7. **A limit that runs the use case and then complains is not a limit.** The limiter sits at the front of
   the shared registry, ahead of parsing, so both doors answer with the same taxonomy the renderers
   already own (`rate_limited` → 429 + `retry-after`). It is keyed by **credential**, not by actor: two
   tokens for the same actor are two clients, and merging them lets one runaway process spend the other's
   budget.
8. **Lease status is the domain's word, not the page's.** `leaseStatus` is a policy function and the read
   model reports it; `EXPIRING_WINDOW_MS` is the same fact the guard already uses one step later, when it
   refuses a `result` comment on an expired lease. The aggregate's wire shape carries no status, because
   status is a fact about the moment of a read — which is why the client test asserts its absence, and why
   the page renders a word instead of computing staleness.
9. **The transport has to say which door it came through** (`withTransport`), so one log shape serves
   stdio, MCP over HTTP, and REST. Without it the same tool call is recorded as if it had no origin.
10. **A demo root needs a live clock.** The injected clock is what makes a timestamp readable in a test,
    but the frozen clock in the composition root made the bucket never refill and every log line carry the
    same `at`. A rate limiter and a log are both facts about time: the wiring that runs the board needs the
    real one, the tests keep the injected one.
11. **A read model must not hand out the domain's own array.** `exactOptionalPropertyTypes` caught
    `AgentView.scopes` being passed by reference; the view copies, because a caller that mutates a view can
    reach into the aggregate.

### The test that matters most in M7

`tests/adapters/ratelimit.test.ts` — it refuses the call that spends the budget *before the use case runs*,
which is only provable because the fake application records whether it was reached; then it shows the same
refusal arrives as `429` + `retry-after` over a route and as `isError` + `code: 'rate_limited'` over the
protocol, refills, and stays keyed by credential. `tests/domain/policy.test.ts` is the pair: it refuses the
fleet minting its own members, and it makes the lease-status window agree with the guard that refuses a
result comment on an expired lease — the same lease, the same word, two places that cannot disagree.
`tests/adapters/logging.test.ts` proves the sink never contains the token, and `tests/web/agents.test.ts`
proves the page does not decide staleness: the server clock advances, and the card still shows the word the
server said.
