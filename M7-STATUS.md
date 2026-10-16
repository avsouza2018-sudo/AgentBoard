# M7 — agent registry, lease indicators, rate limit, structured logging

**Status: complete.** `pnpm typecheck` clean (both tsconfigs), `pnpm dep-check` exit 0 (117 modules,
243 dependencies), `pnpm test` **120 passing (18 files)**, `pnpm contract` regenerated (17 tools,
14 paths). Workspace: `/home/oem/developer/agentboard`.

This file was the handoff notes while M7 was open; it now records what was built, the decisions that
shaped it, and what is still open. `PLAN.md` §13 carries the milestone row and the reasoning.

---

## 1. What M7 was

From `PLAN.md` §10: agent registry, lease indicators, rate limit, structured logging, README with an
example agent session. OpenAPI was generated in M5 and stayed as is — the two new operations appear in
it because the routes are generated from the tool definitions.

Decisions it had to honour: rate limiting per-token **in an adapter** with `retryable` + `retryAfter`;
attribution mandatory on every write; ports in `domain/ports`; CQRS-lite; `web-consumes-the-contract-only`.

---

## 2. What was built

**Domain** — `ports/actorRegistry.ts` (`Registration`, `ActorRegistry.register/list`,
`RegistrationProvenance`), `policy/registry.ts` (`canRegisterPrincipal`), `policy/lease.ts`
(`LeaseStatus`, `EXPIRING_WINDOW_MS = 120000`, `leaseStatus(lease, now)`), `Board.grant` +
`get members()`, `BoardRepository.save`.

**Infra** — `memory/actorResolver.ts` implements `ActorResolver + ActorDirectory + ActorRegistry`
(mints `tok-<actorId>`, injected `Clock`); `postgres/actorStore.ts` (mints `crypto.randomUUID()`,
`list` joins `api_tokens` + `actors`); `postgres/mapper.ts` (`RegistrationRow`); `save` on both board
repositories; `migrations/002_agent_registry.sql` (`created_by`, `run_id`, `registered_at`,
`api_tokens_actor_idx`).

**Application** — `Deps.agents: ActorRegistry`; `commands/registerAgent.ts` (policy gate → mint →
`board.grant` → `boards.save`, returns the `Registration`); `queries/listAgents.ts` (`AgentView` with
`registeredBy`, `held`, `lastActivityAt`; agents first, then humans, then by name); `queries/map.ts`
(`LeaseView.status`); facade exposes `registerAgent` and `listAgents`.

**Adapters** — `rateLimit.ts` (`RateLimiter`, `createTokenBucket`), `logging.ts` (`LogEntry`,
`LogSink`, `jsonLineSink`, `collectSink`), `toolRegistry.ts` (`RegistryOptions`, limiter → parse →
provenance → tool, one entry per call), `toolContext.ts` (`actorId`, `transport`, awaitable
`ContextResolver`, `withTransport`), `tools/readTools.ts` `list_agents`, `tools/writeTools.ts`
`register_agent`, both transports and the HTTP router await the resolver and label themselves.

**Web** — `contract.ts` (`AgentView`, `LeaseStatus`, `OPERATIONS.agents`, `FIELDS.agent`, `FIELDS.lease`),
`api.ts` `agents(boardId)`, `store.ts` roster, `ui/fleet.tsx` fleet strip, `card.tsx` lease status chip,
`app.tsx` layout `header / fleet / board+panel`.

**Tests** — 30 new: 7 policy (registry + lease status), 6 registry, 5 rate limit, 6 logging, 6 web agents;
assertions refreshed in the contract, client, stdio, http, and migration tests. 120 in total.

---

## 3. Findings from the work

- **The fleet cannot create its own members** — that is the whole point of `canRegisterPrincipal`, and it
  is a domain policy, not a middleware.
- **The domain must not know what a credential looks like.** The port returns an opaque handle; the harness
  seeds fixture tokens directly so it does not depend on either format.
- **The log must never print the credential.** It names `actorId`; `registeredBy` is `null` for exactly one
  row, the seed.
- **The limiter must refuse before the use case runs** — a limit that runs the use case and then complains
  is not a limit — and it is keyed by token, not actor.
- **Lease status is the domain's word**, reported by the read model; the aggregate wire shape carries none,
  because status is a fact about the moment of a read. The page renders the word.
- **One log entry per call**, whatever the outcome, so a validation error, a refusal and a rate limit all
  appear. `route` comes from the tool definition, so both doors log the same path.
- **`RateLimitedError` detail was renamed to `retryAfter`** — the taxonomy wrote
  `retryAfterSeconds` while `renderHttp` reads `details.retryAfter` for the header. The taxonomy and the
  transport disagreed on a field name.
- **The demo wiring needed a live clock**: a `FixedClock` made the bucket never refill and every log line
  carry the same timestamp.
- `dependency-cruiser` stays green with the new files; `pnpm contract` must be re-run when the tool surface
  changes, and the committed snapshots are now 17 tools / 14 paths.

---

## 4. Live check (real run, pasted in `README.md`)

API on 3000 (or 3056 for the rate-limit demo with `RATE_LIMIT_CAPACITY=3 RATE_LIMIT_REFILL_PER_SECOND=1`),
vite on 5173 proxying `/api`, `Bearer tok-agent-atlas`. The captured session: `who_am_i`, the roster, an
agent refused with `permission`, ada mints vega, create + claim, the roster reporting `held` and the lease
`status`, then a `429` with `retry-after=1` and the log lines that name the actor and never the token.

---

## 5. Still open

1. **Decision #1 — idempotency keys on agent writes** is unimplemented; write tools honestly report
   `idempotentHint: false`.
2. The limiter is **per-process** (an in-memory bucket). Multi-instance deployment needs a shared store or
   a gateway limit; the port shape is already right for that.
3. No retention policy for the operational log; no rotation. `jsonLineSink` writes to stderr.
4. No lint; no root `pnpm build` beyond the web app's `vite build`.
5. The fleet panel has no registration form — the page can only read the roster, because the domain is the
   only place that decides who may mint a credential.
