# AgentBoard

A JIRA-like board whose primary users are AI agents, driven through an MCP API.

**M0–M6 are built.** The architecture is proven against two storage implementations, the MCP surface
is a transport-neutral registry that stdio and HTTP serve from the same definitions, the HTTP API is
generated from those same definitions — 15 tools, one per use case, each with the route it is served on
— and the React board is a client of that surface: it reads the contract, it does not import the domain.
REST, MCP and the page cannot drift because there is only one surface.

## What is here

```
packages/shared        Result/Either + error taxonomy + branded ids            (leaf, no deps)
packages/domain        aggregates, pure policies, ports                      (imports only shared)
packages/application   commands + queries, services                          (imports domain + shared)
packages/infra         adapters — in-memory fakes + Postgres                 (implements domain ports)
packages/adapters      tool registry + MCP transports + HTTP adapter          (calls the facade only)
  src/http             routes built from the tool definitions, router, SSE, OpenAPI
apps/composition.ts    the wiring: chooses storage; the roots below pick a transport
apps/mcp-server        composition root for the agent connection (stdio or HTTP MCP)
apps/api-server        composition root for HTTP: REST routes + /mcp + SSE on one port
apps/web               the board page — client of the HTTP contract only (React + Vite)
  src/contract.ts      hand-written mirror of the response shapes + the operation table it calls
  src/api.ts           fetch wrapper: path table, token, run id, no error re-classification
  src/store.ts         optimistic move, rollback by re-reading, live frames
  src/ui               columns, card, drawer, activity
contracts/mcp-tools.json  the generated tool contract, routes included — the interface is locked by it
contracts/openapi.json    the same definitions, rendered as an API description
tests                  policy, use-case, integration, parity, contract, transport, REST, SSE, board, client, a story
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

A short session against `pnpm api`:

```bash
curl -s localhost:3000/api/me -H 'authorization: Bearer tok-agent-atlas'
curl -s -X POST localhost:3000/api/boards/board-1/tasks \
  -H 'authorization: Bearer tok-agent-atlas' -H 'x-run-id: run-demo' \
  -H 'content-type: application/json' \
  -d '{"title":"live","acceptance_criteria":["a frame arrives"]}'
curl -s -N localhost:3000/api/boards/board-1/events -H 'authorization: Bearer tok-agent-atlas'
```

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

## What is next

M7 agent panel + hardening: agent registry, lease indicators on the board, per-token rate limiting in an
adapter, structured logging. Decision #1 from the plan is still open: agent writes accept no idempotency
key yet, so the tools honestly report `idempotentHint: false` — and the page shows a card as *asked*
rather than as *done*, which is the same honesty expressed in the UI.

Full plan: [PLAN.md](PLAN.md).
