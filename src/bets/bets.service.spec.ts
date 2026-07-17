import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import Redis from 'ioredis';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT, RedisModule } from '../redis/redis.module';
import { leaderboardKey } from '../tournaments/leaderboard.keys';
import { LeaderboardService } from '../tournaments/leaderboard.service';
import { SnapshotService } from '../tournaments/snapshot.service';
import { BetsService } from './bets.service';
import { CreateBetDto } from './dto/create-bet.dto';

/**
 * Integration tests against the real Postgres + Redis from docker-compose.
 * These are the two properties the whole design exists to guarantee —
 * per-tournament idempotency and multi-tournament fan-out — so they are tested
 * against real infrastructure rather than mocks. A mocked unique constraint
 * would prove nothing: the constraint *is* the guarantee.
 *
 *   docker compose up -d && npx prisma migrate deploy && npm test
 */
describe('BetsService (integration)', () => {
  let moduleRef: TestingModule;
  let bets: BetsService;
  let snapshots: SnapshotService;
  let leaderboard: LeaderboardService;
  let prisma: PrismaService;
  let redis: Redis;

  const WINDOW_START = new Date('2026-06-04T12:00:00.000Z');
  const WINDOW_END = new Date('2026-06-04T13:00:00.000Z');
  const IN_WINDOW = new Date('2026-06-04T12:30:00.000Z');

  const betDto = (overrides: Partial<CreateBetDto> = {}): CreateBetDto => ({
    externalBetId: 'bet_123456',
    playerId: 'player_42',
    amount: 250,
    currency: 'USD',
    createdAt: IN_WINDOW,
    ...overrides,
  });

  const makeTournament = (
    name: string,
    startsAt = WINDOW_START,
    endsAt = WINDOW_END,
  ) => prisma.tournament.create({ data: { name, startsAt, endsAt } });

  const scoreOf = (tournamentId: string, playerId: string) =>
    redis.zscore(leaderboardKey(tournamentId), playerId);

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        RedisModule,
      ],
      providers: [BetsService, LeaderboardService, SnapshotService],
    }).compile();

    await moduleRef.init();
    bets = moduleRef.get(BetsService);
    snapshots = moduleRef.get(SnapshotService);
    leaderboard = moduleRef.get(LeaderboardService);
    prisma = moduleRef.get(PrismaService);
    redis = moduleRef.get(REDIS_CLIENT);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    const tournaments = await prisma.tournament.findMany({
      select: { id: true },
    });
    if (tournaments.length > 0) {
      await redis.del(...tournaments.map((t) => leaderboardKey(t.id)));
    }
    await prisma.tournamentPlacement.deleteMany();
    await prisma.tournamentBet.deleteMany();
    await prisma.bet.deleteMany();
    await prisma.tournament.deleteMany();
  });

  it('counts a bet once per tournament when the same event is replayed', async () => {
    const tournament = await makeTournament('replay');

    const first = await bets.ingest(betDto());
    expect(first.accepted).toEqual([tournament.id]);
    expect(first.duplicate).toBe(false);

    const second = await bets.ingest(betDto());

    // The replay is a success, not an error, and moves nothing.
    expect(second.duplicate).toBe(true);
    expect(second.accepted).toEqual([]);
    expect(second.alreadyCounted).toEqual([tournament.id]);
    expect(second.betId).toBe(first.betId);

    expect(await scoreOf(tournament.id, 'player_42')).toBe('250');
    expect(await prisma.tournamentBet.count()).toBe(1);
  });

  it('stays idempotent when the same bet arrives concurrently', async () => {
    const tournament = await makeTournament('concurrent');

    // The unique index, not the application, is what serializes these.
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => bets.ingest(betDto())),
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled');
    expect(succeeded.length).toBeGreaterThan(0);

    expect(await prisma.tournamentBet.count()).toBe(1);
    expect(await scoreOf(tournament.id, 'player_42')).toBe('250');
  });

  it('counts one bet towards every overlapping tournament, once each', async () => {
    const a = await makeTournament('overlap-a');
    const b = await makeTournament(
      'overlap-b',
      new Date('2026-06-04T12:15:00.000Z'),
      new Date('2026-06-04T14:00:00.000Z'),
    );

    const result = await bets.ingest(betDto());
    expect(result.accepted.sort()).toEqual([a.id, b.id].sort());

    expect(await scoreOf(a.id, 'player_42')).toBe('250');
    expect(await scoreOf(b.id, 'player_42')).toBe('250');

    // Replaying must not double-count in either tournament.
    const replay = await bets.ingest(betDto());
    expect(replay.duplicate).toBe(true);
    expect(await scoreOf(a.id, 'player_42')).toBe('250');
    expect(await scoreOf(b.id, 'player_42')).toBe('250');
  });

  it('ignores bets whose event time falls outside the window', async () => {
    const tournament = await makeTournament('window');

    const before = await bets.ingest(
      betDto({
        externalBetId: 'bet_before',
        createdAt: new Date('2026-06-04T11:59:59.999Z'),
      }),
    );
    const after = await bets.ingest(
      betDto({
        externalBetId: 'bet_after',
        createdAt: new Date('2026-06-04T13:00:00.001Z'),
      }),
    );

    expect(before.accepted).toEqual([]);
    expect(after.accepted).toEqual([]);
    expect(await scoreOf(tournament.id, 'player_42')).toBeNull();

    // The raw bets are still recorded — they just count nowhere.
    expect(await prisma.bet.count()).toBe(2);
    expect(await prisma.tournamentBet.count()).toBe(0);
  });

  it('treats the window boundaries as inclusive', async () => {
    const tournament = await makeTournament('boundaries');

    await bets.ingest(
      betDto({ externalBetId: 'bet_start', createdAt: WINDOW_START }),
    );
    await bets.ingest(
      betDto({ externalBetId: 'bet_end', createdAt: WINDOW_END }),
    );

    expect(await scoreOf(tournament.id, 'player_42')).toBe('500');
  });

  it('sums a running score per player and ranks by score DESC', async () => {
    const tournament = await makeTournament('ranking');

    await bets.ingest(betDto({ externalBetId: 'b1', playerId: 'alice', amount: 100 }));
    await bets.ingest(betDto({ externalBetId: 'b2', playerId: 'alice', amount: 250 }));
    await bets.ingest(betDto({ externalBetId: 'b3', playerId: 'bob', amount: 900 }));

    const { rows, total } = await leaderboard.page(tournament.id, 10, 0);
    expect(total).toBe(2);
    expect(rows).toEqual([
      { rank: 1, playerId: 'bob', score: 900 },
      { rank: 2, playerId: 'alice', score: 350 },
    ]);
  });

  it('rebuilds the leaderboard from Postgres when the Redis key is gone', async () => {
    const tournament = await makeTournament('rebuild');
    await bets.ingest(betDto({ externalBetId: 'b1', playerId: 'alice', amount: 100 }));
    await bets.ingest(betDto({ externalBetId: 'b2', playerId: 'bob', amount: 400 }));

    // Simulate Redis losing the key: it is a derived cache, not truth.
    await redis.del(leaderboardKey(tournament.id));

    const { rows, total } = await leaderboard.page(tournament.id, 10, 0);
    expect(total).toBe(2);
    expect(rows).toEqual([
      { rank: 1, playerId: 'bob', score: 400 },
      { rank: 2, playerId: 'alice', score: 100 },
    ]);
  });

  it('paginates the leaderboard', async () => {
    const tournament = await makeTournament('paging');
    for (const [i, player] of ['a', 'b', 'c'].entries()) {
      await bets.ingest(
        betDto({
          externalBetId: `b${i}`,
          playerId: player,
          amount: (i + 1) * 100,
        }),
      );
    }

    const page = await leaderboard.page(tournament.id, 1, 1);
    expect(page.total).toBe(3);
    expect(page.rows).toEqual([{ rank: 2, playerId: 'b', score: 200 }]);
  });

  describe('snapshot', () => {
    it('freezes ranked placements and is safe to run twice', async () => {
      const tournament = await makeTournament('snapshot');
      await bets.ingest(betDto({ externalBetId: 'b1', playerId: 'alice', amount: 100 }));
      await bets.ingest(betDto({ externalBetId: 'b2', playerId: 'bob', amount: 900 }));

      await snapshots.finalize(tournament.id);

      const placements = await prisma.tournamentPlacement.findMany({
        where: { tournamentId: tournament.id },
        orderBy: { rank: 'asc' },
        select: { playerId: true, score: true, rank: true },
      });
      expect(placements).toEqual([
        { playerId: 'bob', score: 900, rank: 1 },
        { playerId: 'alice', score: 100, rank: 2 },
      ]);

      // The live key is dropped once results are frozen.
      expect(await redis.exists(leaderboardKey(tournament.id))).toBe(0);

      // A retried job must recompute the same rows, not collide or duplicate.
      await expect(snapshots.finalize(tournament.id)).resolves.toEqual({
        players: 2,
      });
      expect(
        await prisma.tournamentPlacement.count({
          where: { tournamentId: tournament.id },
        }),
      ).toBe(2);
    });

    it('computes placements from Postgres even if Redis drifted', async () => {
      const tournament = await makeTournament('drift');
      await bets.ingest(betDto({ externalBetId: 'b1', playerId: 'alice', amount: 100 }));

      // Corrupt the cache. Truth lives in the ledger, so the snapshot ignores this.
      await redis.zadd(leaderboardKey(tournament.id), 999999, 'alice');

      await snapshots.finalize(tournament.id);

      const placement = await prisma.tournamentPlacement.findFirst({
        where: { tournamentId: tournament.id },
      });
      expect(placement?.score).toBe(100);
    });
  });
});
