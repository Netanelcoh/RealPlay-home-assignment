import { Injectable, Logger } from '@nestjs/common';
import { TournamentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LeaderboardService } from './leaderboard.service';

@Injectable()
export class SnapshotService {
  private readonly logger = new Logger(SnapshotService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly leaderboard: LeaderboardService,
  ) {}

  /** Freezes final placements after endsAt.
   *
   *  Scores come from the Postgres ledger, never from Redis: the snapshot is the
   *  published result, so it has to be right even if the ZSET drifted or was
   *  flushed mid-tournament. Recomputing from truth also makes the job safe to
   *  retry — a second run produces identical rows. */
  async finalize(tournamentId: string): Promise<{ players: number }> {
    const totals = await this.prisma.tournamentBet.groupBy({
      by: ['playerId'],
      where: { tournamentId },
      _sum: { amount: true },
    });

    // Deterministic ordering: score DESC, then playerId ASC so ties don't shuffle
    // between runs.
    const ranked = totals
      .map((row) => ({ playerId: row.playerId, score: row._sum.amount ?? 0 }))
      .sort((a, b) =>
        b.score !== a.score
          ? b.score - a.score
          : a.playerId.localeCompare(b.playerId),
      )
      .map((row, index) => ({ ...row, rank: index + 1 }));

    await this.prisma.$transaction([
      // Clear first so a retry replaces rather than collides.
      this.prisma.tournamentPlacement.deleteMany({ where: { tournamentId } }),
      this.prisma.tournamentPlacement.createMany({
        data: ranked.map((row) => ({ tournamentId, ...row })),
      }),
      this.prisma.tournament.update({
        where: { id: tournamentId },
        data: { status: TournamentStatus.FINALIZED },
      }),
    ]);

    await this.leaderboard.drop(tournamentId);

    this.logger.log(
      `Finalized tournament ${tournamentId}: ${ranked.length} players ranked`,
    );
    return { players: ranked.length };
  }
}
