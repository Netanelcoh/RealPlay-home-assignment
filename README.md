# RealPlay — Tournaments Module

Creates tournaments, ingests bet events, serves a live leaderboard from Redis, and freezes final placements to Postgres via a BullMQ job after `endsAt`.

## The one idea worth reading

**Postgres is the source of truth; Redis is a derived, rebuildable cache.**

## Running

```bash
docker compose up -d
cp .env.example .env
npm install
npx prisma migrate deploy   # or: npx prisma migrate dev
npm run start:dev           # terminal 1 — API on :3000
npm run start:worker        # terminal 2 — snapshot worker
npm test                    # needs the containers up
```

## Idempotency and multi-tournament fan-out

One mechanism covers both. A bet counts once *per tournament*, so the constraint lives on the participation row, not the event: `@@unique([tournamentId, externalBetId])` on `TournamentBet`.

One statement does the window match, the fan-out and the dedupe ([bets.service.ts:76](src/bets/bets.service.ts#L76)):

```sql
INSERT INTO "TournamentBet" (...)
SELECT ... FROM "Tournament" t
WHERE t."startsAt" <= $createdAt AND t."endsAt" >= $createdAt
ON CONFLICT ("tournamentId", "externalBetId") DO NOTHING
RETURNING "tournamentId"
```

The `SELECT` fans out across every overlapping tournament. The unique index arbitrates duplicates. `RETURNING` yields exactly the rows that landed — and that list, not an application-level "have I seen this?" check, is what drives the `ZINCRBY`. A replay returns nothing and physically cannot reach Redis.

Consequences: the ZSET can be dropped at any time and the next read rebuilds it from the ledger; the snapshot aggregates the ledger rather than Redis, so a retried job recomputes identical rows.

## Assumptions

- **Event time, not arrival time.** Windows match on `createdAt`, never `now()` — a late-arriving bet still counts.
- **Tournaments are open by default.** No eligibility rules or rosters; any overlapping window matches.
- **Score is the raw sum of `amount`**, in integer cents. Ties break by `playerId` descending — not because that ordering means anything, but because Redis orders equal scores by member ascending and `ZREVRANGE` reverses it. The snapshot matches, so a tied player's rank does not shift when the tournament finalizes.
- **Windows are immutable once created.** Nothing re-runs the fan-out, so there is no update endpoint.
- **`externalBetId` identifies one real-world bet.** A resend with a different amount is a replay; the original stands.

## Trade-offs (known gaps)

- **Crash between the DB commit and `ZINCRBY`.** Redis reads low until the next rebuild. Accepted: Postgres stays authoritative. Moving the increment inside the transaction only inverts the failure into a direction that can't self-heal. The real fix is a transactional outbox.
- **The snapshot boundary.** An in-window bet arriving after the snapshot gets a ledger row and a warning, but can't move frozen placements — `finalize()` no-ops once a tournament is `FINALIZED`, so published results stay immutable even across a job retry. The transaction doesn't help — under `READ COMMITTED` the snapshot takes no locks. Closing it properly needs `FOR SHARE`/`FOR UPDATE` on the `Tournament` row plus a grace period on the job delay.
- **The snapshot schedule lives only in Redis.** The delayed BullMQ job is the sole finalize trigger. The leaderboard heals after a Redis flush; the schedule does not, so a tournament would stay `SCHEDULED` forever. A periodic sweep over `endsAt < now() AND status = 'SCHEDULED'` would close it.
- **A rebuild can swallow a concurrent bet.** Rebuild reads totals from Postgres, then writes them with `ZADD` — an absolute set. A `ZINCRBY` landing between the read and the write gets overwritten (`groupBy` sees alice=500 → `ZINCRBY +100` → `ZADD 500`, and the 100 is gone). Redis then reads low against the ledger indefinitely, since `ZCARD` is no longer 0 and nothing triggers another rebuild. The snapshot is unaffected — it reads the ledger. A Lua script doing read-and-set atomically would close it.
- **`ZCARD == 0` is the only "cache is missing" signal**, and it can't tell a lost cache from a tournament that genuinely has no bets yet. An empty tournament therefore runs a Postgres aggregate on every leaderboard read.
- **Fan-out is unbounded.** One bet matching N tournaments does N inserts and N Redis commands on the request path.
- **Multi-currency.** Amounts are summed without FX conversion. `currency` is stored, so this is fixable without a migration.
- **No auth, rate limiting, metrics, or structured logging.** `POST /bet` is an unauthenticated write endpoint.

## Layout

```
prisma/schema.prisma                    # ledger + unique constraint = the guarantee
src/bets/bets.service.ts                # ingest, fan-out, idempotency
src/tournaments/leaderboard.service.ts  # ZSET read/write + rebuild-from-ledger
src/tournaments/snapshot.service.ts     # finalize from Postgres, safe to retry
src/tournaments/tournaments.service.ts  # create + schedule, leaderboard paging
src/worker.ts                           # separate worker entrypoint
src/bets/bets.service.spec.ts           # idempotency + fan-out, against real infra
```
