import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../redis/redis.module';
import { leaderboardKey } from './leaderboard.keys';

export interface ScoreIncrement {
  tournamentId: string;
  playerId: string;
  amount: number;
}

export interface LeaderboardRow {
  rank: number;
  playerId: string;
  score: number;
}

@Injectable()
export class LeaderboardService {
  private readonly logger = new Logger(LeaderboardService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly prisma: PrismaService,
  ) {}

  /** Called only for ledger rows that were actually inserted, so a replayed
   *  bet never reaches this method and never double-increments. */
  async applyIncrements(increments: ScoreIncrement[]): Promise<void> {
    if (increments.length === 0) return;

    const pipeline = this.redis.pipeline();
    for (const { tournamentId, playerId, amount } of increments) {
      pipeline.zincrby(leaderboardKey(tournamentId), amount, playerId);
    }
    await pipeline.exec();
  }

  async page(
    tournamentId: string,
    limit: number,
    offset: number,
  ): Promise<{ rows: LeaderboardRow[]; total: number }> {
    const key = leaderboardKey(tournamentId);

    let total = await this.redis.zcard(key);
    if (total === 0) {
      // Either the tournament genuinely has no bets, or Redis lost the key.
      // Postgres is the source of truth, so ask it rather than assume.
      total = await this.rebuildFromLedger(tournamentId);
    }
    if (total === 0) return { rows: [], total: 0 };

    const flat = await this.redis.zrevrange(
      key,
      offset,
      offset + limit - 1,
      'WITHSCORES',
    );

    const rows: LeaderboardRow[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      rows.push({
        rank: offset + i / 2 + 1,
        playerId: flat[i],
        score: Number(flat[i + 1]),
      });
    }
    return { rows, total };
  }

  /** Rebuilds the ZSET from the ledger. This is what makes "Redis is a derived
   *  cache" a real property: the key can be dropped at any time and the next
   *  read reconstructs it. Returns the number of ranked players. */
  async rebuildFromLedger(tournamentId: string): Promise<number> {
    const totals = await this.prisma.tournamentBet.groupBy({
      by: ['playerId'],
      where: { tournamentId },
      _sum: { amount: true },
    });
    if (totals.length === 0) return 0;

    const key = leaderboardKey(tournamentId);
    const pipeline = this.redis.pipeline();
    for (const row of totals) {
      pipeline.zadd(key, row._sum.amount ?? 0, row.playerId);
    }
    await pipeline.exec();

    this.logger.log(
      `Rebuilt leaderboard ${key} from ledger (${totals.length} players)`,
    );
    return totals.length;
  }

  async drop(tournamentId: string): Promise<void> {
    await this.redis.del(leaderboardKey(tournamentId));
  }
}
