import { Injectable, Logger } from '@nestjs/common';
import { TournamentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  LeaderboardService,
  ScoreIncrement,
} from '../tournaments/leaderboard.service';
import { CreateBetDto } from './dto/create-bet.dto';

export interface IngestResult {
  betId: string;
  externalBetId: string;
  /** Tournaments this call newly counted the bet towards. Empty on a replay. */
  accepted: string[];
  /** Tournaments where an earlier call already counted this bet. */
  alreadyCounted: string[];
  duplicate: boolean;
}

interface BetRow {
  id: string;
  externalBetId: string;
  playerId: string;
  amount: number;
}

@Injectable()
export class BetsService {
  private readonly logger = new Logger(BetsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly leaderboard: LeaderboardService,
  ) {}

  async ingest(dto: CreateBetDto): Promise<IngestResult> {
    const { bet, accepted, alreadyCounted, increments } =
      await this.prisma.$transaction(async (tx) => {
        // 1. The raw event. A replay must reuse the existing row, not error, so
        //    this is an upsert. DO UPDATE (rather than DO NOTHING) so the row
        //    comes back via RETURNING on the conflict path too.
        const [bet] = await tx.$queryRaw<BetRow[]>`
          INSERT INTO "Bet" ("id", "externalBetId", "playerId", "amount", "currency", "createdAt")
          VALUES (
            gen_random_uuid()::text,
            ${dto.externalBetId},
            ${dto.playerId},
            ${dto.amount},
            ${dto.currency},
            ${dto.createdAt}
          )
          ON CONFLICT ("externalBetId")
            DO UPDATE SET "externalBetId" = EXCLUDED."externalBetId"
          RETURNING "id", "externalBetId", "playerId", "amount"
        `;

        // 2. Every tournament whose window contains the bet's *event* time.
        //    A bet can legitimately land in several overlapping tournaments.
        const matching = await tx.tournament.findMany({
          where: {
            startsAt: { lte: dto.createdAt },
            endsAt: { gte: dto.createdAt },
          },
          select: { id: true, status: true },
        });

        // 3. Fan out. One statement does the window match, the fan-out and the
        //    dedupe atomically: ON CONFLICT DO NOTHING lets the unique index
        //    decide what counts, and RETURNING tells us exactly which rows were
        //    genuinely inserted. A replay inserts nothing and returns nothing,
        //    so it can never reach the ZINCRBY below.
        //
        //    Deliberately not a per-row create() in a try/catch: a failed
        //    statement aborts the surrounding Postgres transaction. And not
        //    createMany({ skipDuplicates }): that returns a count, not the rows.
        const inserted = await tx.$queryRaw<{ tournamentId: string }[]>`
          INSERT INTO "TournamentBet" ("id", "tournamentId", "betId", "externalBetId", "playerId", "amount")
          SELECT
            gen_random_uuid()::text,
            t."id",
            ${bet.id},
            ${bet.externalBetId},
            ${bet.playerId},
            ${bet.amount}
          FROM "Tournament" t
          WHERE t."startsAt" <= ${dto.createdAt}
            AND t."endsAt" >= ${dto.createdAt}
          ON CONFLICT ("tournamentId", "externalBetId") DO NOTHING
          RETURNING "tournamentId"
        `;

        const accepted = inserted.map((row) => row.tournamentId);
        const acceptedSet = new Set(accepted);
        const alreadyCounted = matching
          .map((t) => t.id)
          .filter((id) => !acceptedSet.has(id));

        // The ledger row is written regardless — it is the audit trail. But a
        // tournament whose placements are already frozen must not have its live
        // ZSET moved; surface that as a warning instead of silently dropping.
        const statusById = new Map(matching.map((t) => [t.id, t.status]));
        const increments: ScoreIncrement[] = [];
        for (const tournamentId of accepted) {
          if (statusById.get(tournamentId) === TournamentStatus.FINALIZED) {
            this.logger.warn(
              `Late bet ${bet.externalBetId} landed in already-finalized ` +
                `tournament ${tournamentId}; placements unchanged`,
            );
            continue;
          }
          increments.push({
            tournamentId,
            playerId: bet.playerId,
            amount: bet.amount,
          });
        }

        return { bet, accepted, alreadyCounted, increments };
      });

    // 4. Only after the ledger has committed. If the process dies here Redis
    //    reads low until the next rebuild — Postgres still holds the truth.
    await this.leaderboard.applyIncrements(increments);

    return {
      betId: bet.id,
      externalBetId: bet.externalBetId,
      accepted,
      alreadyCounted,
      duplicate: accepted.length === 0 && alreadyCounted.length > 0,
    };
  }
}
