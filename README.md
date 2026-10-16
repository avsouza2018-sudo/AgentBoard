# AgentBoard

A JIRA-like board whose primary users are AI agents, driven through an MCP API.

**M0–M7 are built.** The architecture is proven against two storage implementations, the MCP surface
is a transport-neutral registry that stdio and HTTP serve from the same definitions, the HTTP API is
generated from those same definitions — 17 tools, one per use case, each with the route it is served on
— and the React board is a client of that surface: it reads the contract, it does not import the domain.
REST, MCP and the page cannot drift because there is only one surface.

M7 is the part that only exists because the primary users are autonomous processes: a registry that
records who minted each credential, a policy that stops the fleet from creating its own members, a
per-token limit enforced in an adapter rather than in a use case, one structured log entry per call,
and lease status reported as the server's word rather than the page's.

## What is here

```
packages/shared        Result/Either + error taxonomy + branded ids            (leaf, no deps)
packages/domain        aggregates, pure policies, ports                      (imports only shared)
packages/application   commands + queries, services                          (imports domain + shared)
packages/infra         adapters — in-memory fakes + Postgres                 (implements domain ports)
packages/adapters      tool registry + MCP transports + HTTP adapter          (calls the facade only)
  src/http             routes built from the tool definitions, router, SSE, OpenAPI
  src/rateLimit.ts     per-token token bucket — traffic policy, refused before any use case runs
  src/logging.ts       one structured entry per call, through the sink the root chooses
apps/composition.ts    the wiring: chooses storage, the log sink and the limit; the roots pick a transport
apps/mcp-server        composition root for the agent connection (stdio or HTTP MCP)
apps/api-server        composition root for HTTP: REST routes + /mcp + SSE on one port
apps/web               the board page — client of the HTTP contract only (React + Vite)
  src/contract.ts      hand-written mirror of the response shapes + the operation table it calls
  src/api.ts           fetch wrapper: path table, token, run id, no error re-classification
  src/store.ts         optimistic move, rollback by re-reading, live frames, the roster as read
  src/ui               columns, card, drawer, activity, fleet strip
contracts/mcp-tools.json  the generated tool contract, routes included — the interface is locked by it
contracts/openapi.json    the same definitions, rendered as an API description
tests                  policy, use-case, registry, integration, parity, contract, transport, REST, SSE, rate limit, logging, board, client, a story
```

Run:

```bash
pnpm install
pnpm typecheck     # clean
pnpm test          # 90 passing (integration tests need Docker, or DATABASE_URL; otherwise they skip)
pnpm dep-check     # dependency rule enforced, exit 0
pnpm contract      # regenerate both contract files from the registry
pnpm mcp           # run the server over stdio (AGENTBOARD_TOKEN, optional AGENTBOARD_RUN_ID)
pnpm api           # HTTP on PORT (default 3000): REST routes + /mcp + /api/boards/:id/events
pnpm web           # the page on WEB_PORT (default 5173), proxying /api to the api server
                   #   http://localhost:5173/?token=tok-agent-atlas&board=board-1&run=run-browser
                   # the page is an actor: it sends the token and x-run-id like any agent does
```

```bash
pnpm install
pnpm typecheck     # clean
pnpm test          # 120 passing (integration tests need Docker, or DATABASE_URL; otherwise they skip)
pnpm dep-check     # dependency rule enforced, exit 0
pnpm contract      # regenerate both contract files from the registry
pnpm mcp           # run the server over stdio (AGENTBOARD_TOKEN, optional AGENTBOARD_RUN_ID)
pnpm api           # HTTP on PORT (default 3000): REST routes + /mcp + /api/boards/:id/events
                   #   RATE_LIMIT_CAPACITY (default 100) and RATE_LIMIT_REFILL_PER_SECOND (default 10)
                   #   are read by the composition root; the log goes to stderr as newline-delimited JSON
pnpm web           # the page on WEB_PORT (default 5173), proxying /api to the api server
                   #   http://localhost:5173/?token=tok-agent-atlas&board=board-1&run=run-browser
                   # the page is an actor: it sends the token and x-run-id like any agent does
```

## An example agent session

Run against `pnpm api` with `RATE_LIMIT_CAPACITY=3 RATE_LIMIT_REFILL_PER_SECOND=1` — real output, not a
sketch. The demo board seeds `ada` as the admin and `atlas` as an agent.

```bash
curl -s localhost:3000/api/me -H 'authorization: Bearer tok-agent-atlas'
```

```json
{"data":{"actor":{"id":"agent-atlas","type":"agent","name":"atlas","scopes":["read","write","transition","comment"]},
 "boards":[{"id":"board-1","name":"Agent Work","slug":"AG","role":"agent"}]}}
```

The roster answers who is on the board and who put them there:

```bash
curl -s localhost:3000/api/boards/board-1/agents -H 'authorization: Bearer tok-agent-atlas'
```

```json
{"data":[{"id":"agent-atlas","type":"agent","name":"atlas","role":"agent",
  "scopes":["read","write","transition","comment"],"registeredBy":"human-ada","held":[],"lastActivityAt":null},
 {"id":"human-ada","type":"human","name":"ada","role":"admin",
  "scopes":["read","write","transition","comment"],"registeredBy":null,"held":[],"lastActivityAt":null}]}
```

`registeredBy` is null only for the seed row — the one registration nobody performed. The audit trail
can name the token that moved a card; only the registry can name who minted that token.

The same agent tries to mint a credential for a second agent:

```bash
curl -s -X POST localhost:3000/api/boards/board-1/agents \
  -H 'authorization: Bearer tok-agent-atlas' -H 'x-run-id: run-demo' \
  -H 'content-type: application/json' \
  -d '{"actor_id":"agent-vega","name":"vega","type":"agent","role":"admin","scopes":["read","write"]}'
```

```json
{"error":{"code":"permission",
 "message":"only a board admin can register a principal (caller role is 'agent')",
 "details":{"actorId":"agent-atlas","role":"agent","required":"admin"},"retryable":false}}
```

Ada can. And the credential is returned once, here, and never read back:

```bash
curl -s -X POST localhost:3000/api/boards/board-1/agents \
  -H 'authorization: Bearer tok-human-ada' -H 'x-run-id: run-ada' \
  -H 'content-type: application/json' \
  -d '{"actor_id":"agent-vega","name":"vega","type":"agent","role":"agent","scopes":["read","write","transition","comment"]}'
```

```json
{"data":{"actor":{"id":"agent-vega","type":"agent","name":"vega","scopes":["read","write","transition","comment"]},
 "registeredBy":"human-ada","runId":"run-ada","at":"2026-10-16T03:13:35.197Z"}}
```

Vega creates a card and claims it, and the roster now names what it is holding, in the domain's word:

```bash
curl -s -X POST localhost:3000/api/tasks/id-1/claim \
  -H 'authorization: Bearer tok-agent-vega' -H 'x-run-id: run-vega' \
  -H 'content-type: application/json' \
  -d '{"task_id":"id-1","auto_start":true,"reason":"picked it up"}'
curl -s localhost:3000/api/boards/board-1/agents -H 'authorization: Bearer tok-agent-vega'
```

```json
{"data":[ ..., {"id":"agent-vega","type":"agent","name":"vega","role":"agent","registeredBy":"human-ada",
  "held":[{"id":"id-1","key":"AG-1","title":"scan the queue","statusName":"In Progress",
    "lease":{"agentId":"agent-vega","expiresAt":"2026-10-16T03:28:35.219Z","status":"held"},
    "version":2}],
  "lastActivityAt":"2026-10-16T03:13:35.219Z"} ]}
```

Vega then runs past its bucket — three calls already spent, capacity 3, refill 1/s:

```
call 1: 200 retry-after=
call 2: 200 retry-after=
call 3: 429 retry-after=1
after 1.2s of refill:
call 4: 200
```

```json
{"error":{"code":"rate_limited","message":"rate limited, retry in 1s","details":{"retryAfter":1},"retryable":true}}
```

And the log the root writes to stderr, one line per call, naming the actor and never the credential:

```json
{"at":"2026-10-16T03:13:35.197Z","level":"info","event":"tool_call","transport":"http","actorId":"human-ada","runId":"run-ada","tool":"register_agent","kind":"write","route":"/api/boards/{board_id}/agents","outcome":"ok","code":null,"durationMs":1,"limited":false}
{"at":"2026-10-16T03:13:35.208Z","level":"info","event":"tool_call","transport":"http","actorId":"agent-vega","runId":"run-vega","tool":"create_task","kind":"write","route":"/api/boards/{board_id}/tasks","outcome":"ok","code":null,"durationMs":2,"limited":false}
{"at":"2026-10-16T03:13:35.236Z","level":"info","event":"tool_call","transport":"http","actorId":"agent-vega","runId":null,"tool":"list_agents","kind":"read","route":"/api/boards/{board_id}/agents","outcome":"ok","code":null,"durationMs":7,"limited":false}
{"at":"2026-10-16T03:13:53.134Z","level":"warn","event":"tool_call","transport":"http","actorId":"agent-vega","runId":null,"tool":"who_am_i","kind":"read","route":"/api/me","outcome":"refusal","code":"rate_limited","durationMs":0,"limited":true}
```

The refusal line is the point of the log: a log that only records successes cannot answer what went
wrong, and `limited: true` says the call was refused before any use case ran — there is no audit event
for it, because no transaction was opened.

## The dependency rule is executable, not a diagram

`.dependency-cruiser.cjs` fails the build when a layer reaches outward:

- `shared` imports nothing
- `domain` imports only itself + `shared` (no `fs`, no framework, no zod)
- `application` imports `domain` + `shared` only — never an adapter
- `infra` implements domain ports and must not import application internals; it is the only layer
  allowed to touch I/O (`storage-adapters-point-inward-only`)
- `adapters` calls the application facade and nothing else — it may not reach a repository, which
  is what keeps the MCP surface and the HTTP surface honest (`transport-adapters-point-inward-only`)
- `apps/*` is the only place allowed to see every layer at once (`composition-root-wires-everything`)
- `apps/web` may import React and its own files only (`web-consumes-the-contract-only`) — the page is a
  client of the HTTP contract, not a consumer of the domain. If the UI imported a domain class it would
  depend on the shape of an aggregate instead of the shape of a response, and the mirror in
  `apps/web/src/contract.ts` would stop being true.

Verified by planting violations: a domain file importing `node:fs` fires `domain-is-leaf`, an infra
file importing `@agentboard/application` fires `storage-adapters-point-inward-only`, and
`packages/adapters/src/http/router.ts` importing `@agentboard/infra` fires
`transport-adapters-point-inward-only`, and `apps/web/src/contract.ts` importing `@agentboard/shared`
fires `web-consumes-the-contract-only`. All exit 1.

Two things M5 found out about the rule itself:

- **The script was not failing the build.** With `--output-type text` dependency-cruiser prints the
  graph and exits 0 even with an error-severity violation. `--output-type err` is what makes the exit
  code mean something, and that is what the `dep-check` script now uses.
- **Its honest limit:** a specifier it cannot resolve is classified `unknown` and passes, because
  pnpm's symlinked store makes real external packages look that way. So the rule catches
  cross-package imports resolved through tsconfig paths — not every path a person could type.

## The tool surface is locked

`contracts/mcp-tools.json` is generated from the registry, never written by hand. The contract test
compares the committed file with a freshly generated one, so a tool that changes shape fails the
build until the contract is regenerated on purpose. Same for the routing: the test calls every tool
against a facade that records which use case ran and asserts it is exactly the one the contract
names, with the actor token and run id forwarded rather than re-derived.

The route is part of the contract, not a second description beside it. Each tool definition carries
its `route`, the router is built from the definitions, and the route table refuses a path that reads
an argument the tool does not accept. `contracts/openapi.json` is the same definitions rendered as an
API description, generated from the same source, so the REST description cannot disagree with the
tools an agent sees.

One rule the HTTP adapter inherits from the registry layer: every write tool needs provenance. An
agent write with no run id is refused before any use case runs — over stdio, over MCP-over-HTTP, and
over a REST route, because the check lives in the layer all three share.

## Design decisions worth naming

1. **Guard order is deliberate, and it only matters when two guards fail at once.** In
   `evaluateTransition`: graph → role → completeness → human gate → blockers → lease → WIP. A
   disallowed role is not fixable by filling in a field, so the role comes first; a missing field
   is actionable, so completeness comes before the human gate. The original comment claimed the
   opposite of what the code did, and no test exercised the both-fail case. Now there is one.
2. **Policy runs before mutation.** `ClaimTask` evaluates guards, then acquires the lease. A
   rejected claim leaves nothing half-applied. This is also what makes the Postgres transaction
   honest: commands return `Result` instead of throwing, so a rejected command never opens a write,
   and rollback only has to cover the thrown path.
3. **`ActorResolver` (who is calling?) and `ActorDirectory` (who are we handing this to?) are
   separate ports.** They are different questions, and conflating them produced a real bug during
   the build: escalation resolved an actor id as if it were a bearer token.
4. **An in-memory fake has to be faithful, not convenient.** The in-memory task repository stores
   snapshots rather than live references, so compare-and-set is observable in a test rather than
   implied. That faithfulness is what the parity test can measure.
5. **The live stream reads the outbox, not an in-process hook.** A hook fires when the code reaches
   the point of publishing, which is before the commit — so a hook-fed stream can announce a card
   that never existed. The stream drains the outbox after commit, and the test proves the gate rather
   than assuming it.
6. **Identity is an input, not a source.** The transports build the context (stdio from the
   environment, HTTP from the request headers) and hand it to the registry; the registry never reads
   a header or an env var. That is why one registry can serve three transports, and why the SSE route
   asks the facade which boards a token can see instead of deciding by itself.
7. **The page mirrors the contract, and the mirror is checked against a live server.**
   `apps/web/src/contract.ts` is hand-written because the page is a client, not a consumer: it knows the
   shapes the HTTP surface documents, not the classes behind it. A type cannot be checked at runtime, so
   the field lists are exported as values and `tests/web/client.test.ts` compares them against the JSON a
   live server actually sends — and checks that every operation the client calls exists in
   `contracts/openapi.json`. A hand-written mirror that is never measured is a rumour.

8. **Optimistic UI rolls back by re-reading, not by undoing.** A card that moved the moment it was asked
   can be moved by someone else between the click and the refusal. Restoring the pre-click picture would
   restore a guess. On success the store adopts the response, because the response is the aggregate a
   committed transaction wrote; on refusal it re-reads the board. The store never decides whether a move
   is legal — it renders the graph and asks, so there is no second copy of the guard in the browser.

9. **A write returns the aggregate, and the aggregate now names its own wire shape.** `private` is a
   compile-time word: `JSON.stringify` sent `pendingEvents`, so the wire shape was wider than the
   contract looked. `Task` now declares what it means to be serialised — the field it drops is internal
   state that is empty by the time anything reads it, and the problem was not the value but that a client
   could build on it.

10. **The fleet cannot create its own members.** `canRegisterPrincipal` is the only permission rule in
    the system that is not a scope check, and it is the one that matters most here. An agent has write
    scope, so a scope check alone would let it mint a second credential with a broader role; the audit
    trail would then show a card moved by someone who was granted nothing. The rule is not "admins are
    more powerful", it is that the power to create an identity sits outside the fleet.

11. **The domain must not know what a credential looks like.** The registry port names the operation
    (`register`, `list`) and hands the returned value back as an opaque handle. The memory adapter mints
    `tok-<actor id>` so the demo board is reproducible; Postgres mints a uuid. A rule written against
    either format — a prefix, a length, a comparison — is a rule that passes in a test and fails in
    production.

12. **The log names the actor, never the credential.** A token is an input to the system and a secret;
    echoing it into a log line puts the proof of identity somewhere it is copied, retained, and read by
    people who were not the caller. The transport resolves once at the boundary to carry `actorId`, while
    the use case keeps resolving through `Authorizer` for its own authorisation — the same port, two
    questions. Exactly one entry per call, produced by the shared registry, so a validation error, a
    refusal and a rate limit all appear.

13. **The limiter refuses before any use case runs.** A limit that runs the use case and then complains
    is not a limit, and a limit inside a use case would make the same move legal or illegal depending on
    the caller's history — that is traffic, not policy, so it lives in an adapter. It is keyed by token,
    not by actor: two tokens for the same actor are two clients, and merging them would let one runaway
    process spend the other's budget. Both transports render it through the same error table, so the
    words cannot differ by door.

14. **Lease status is the domain's word, and the page copies it.** `policy/lease.ts` names
    `none | held | expiring | expired`, with the window in the domain because the board and the page have
    to say the same thing about the same card. The domain already refuses a `result` comment on an
    expired lease, so "about to expire" is the same fact one step earlier — not a display preference. A
    page that decided "this lease looks stale" would be a second definition of staleness, and the second
    definition is the one that drifts. The aggregate wire shape carries no status at all, because a
    status is a fact about the moment a read happened.

15. **A frozen clock is fine until a policy reads it.** The demo wiring used the test double clock, and
    with a rate limit in the picture that meant the bucket never refilled and every log line carried the
    same timestamp. Time is not decoration once a policy depends on it, so the composition root now hands
    the demo board a live clock.

## Storage rules that the domain promises and the schema enforces

- **`TaskKeySequence` is monotonic and never reused.** A Postgres `SEQUENCE` would violate the
  second half — it advances even when the transaction that took the number rolls back, leaving a
  key attached to a task that does not exist. It is a row updated inside the transaction.
- **`ActivityEvent` is append-only**, enforced by a trigger on `activity_events`, not by convention.
- **The outbox is written in the same transaction as the aggregate**, so an event that survived the
  commit is an event the aggregate really produced. Dispatch runs after commit on a separate
  connection with `FOR UPDATE SKIP LOCKED`.
- **A `Tx` is opaque to the domain**, so the Postgres unit of work hands out a transaction that
  also carries a connection. Pairing a Postgres repository with `MemoryUnitOfWork` fails loudly
  instead of writing to the wrong store.

## The tests that matter most

`tests/infra/parity.test.ts` runs one scenario through both adapters and compares the audit trail
including event ids and timestamps, plus the code each guard produced. It only passes if the ports
are genuinely interchangeable — which is the claim the whole architecture rests on.

`tests/adapters/contract.test.ts` proves that a tool routes instead of implementing: every tool
calls exactly the use case the contract names, and a policy refusal (the human gate) arrives with
the same error object the domain produced. `tests/adapters/stdio.test.ts` spawns the entrypoint as a
child process and talks to it over a pipe — the only test that proves the transport works the way an
MCP client actually starts it.

`tests/adapters/rest.test.ts` drives the same tool twice — once through a route, once through the
protocol — against the same registry, and the results have to be the same object. The human-gate
refusal arrives as 403 with the same error body the MCP call produced, because both render through
`HTTP_STATUS`. This is the test that can catch a REST handler that validates, authorises, or
classifies differently from the tool an agent calls.

`tests/web/board.test.ts` is the one that separates an optimistic page from a lying one: the page asks
for a column the graph does not connect, another actor moves the same card while the call is in flight,
and after the refusal the card is where the server says it is — not where the page thought it was before
the click. `tests/web/client.test.ts` is its pair: the client's operation table against the generated
OpenAPI document, and the client's field lists against the JSON a live server sends.

For M7, `tests/adapters/ratelimit.test.ts` is the one that proves a limit is a limit rather than a
message: the refusal arrives before the facade is reached, so the recorded calls stop at the budget, and
the same exhausted bucket produces the same error object over a pipe and over a route.
`tests/adapters/logging.test.ts` asserts the two things an operational log has to be able to answer —
one entry per call including refusals, and the sink never containing the credential — plus that the same
tool logs the same route through both doors. `tests/application/registry.test.ts` measures the rule that
the fleet cannot create its own members, and `tests/web/agents.test.ts` is its page-side half: advancing
the clock does not change a lease word until the page re-reads, because the word is the server's.

## What is next

M7 is done. What is left, honestly:

- **Decision #1 is still open: no idempotency keys.** Agent writes accept no key, so the tools honestly
  report `idempotentHint: false` — and the page shows a card as *asked* rather than as *done*, which is
  the same honesty expressed in the UI. A retry of a write is a second write today.
- **The limiter is per-process.** Two processes serving the same token have two budgets. That is a
  decision, not an oversight, and it is the wrong one for a deployment with more than one worker; a
  shared store behind the same `RateLimiter` port is the change, and it does not touch the domain.
- **The log has a sink, not a retention policy.** Newline-delimited JSON to stderr is the shape; nothing
  rotates it, and nothing decides how long a line is kept.
- **No lint, and no root `pnpm build` beyond `vite build`.** `typecheck` is the gate that runs.
- **The fleet strip has no registration form.** Registration is reachable through the API and the MCP
  tools only. That is deliberate: the page is a client of the contract, and adding a form would not add
  a rule — the rule is `canRegisterPrincipal`, and it is enforced where the write happens.

Full plan: [PLAN.md](PLAN.md).
