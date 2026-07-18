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

/** One row per tournament whose window contains the bet, carrying both its
 *  status and whether *this* call was the one that inserted the ledger row. */
interface MatchedTournamentRow {
  tournamentId: string;
  status: string;
  inserted: boolean;
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

        // 2. Window match, fan-out and dedupe, in one statement.
        //
        //    `matched` is every tournament whose window contains the bet's
        //    *event* time — a bet can legitimately land in several overlapping
        //    tournaments. `ins` fans out across exactly that set, and
        //    ON CONFLICT DO NOTHING lets the unique index, not application
        //    logic, decide what counts. The LEFT JOIN then labels each matched
        //    tournament with whether this call was the one that inserted it.
        //
        //    Both result sets are needed (accepted vs. already-counted), but
        //    they come from a single scan and a single copy of the window
        //    predicate. Splitting this into two statements would give each its
        //    own READ COMMITTED snapshot, so a tournament created between them
        //    would be inserted into but missing from the status lookup — and
        //    would get a ZINCRBY without its status ever being checked.
        //
        //    Deliberately not a per-row create() in a try/catch: a failed
        //    statement aborts the surrounding Postgres transaction. And not
        //    createMany({ skipDuplicates }): that returns a count, not the rows.
        const matched = await tx.$queryRaw<MatchedTournamentRow[]>`
          WITH matched AS (
            SELECT t."id", t."status"
            FROM "Tournament" t
            WHERE t."startsAt" <= ${dto.createdAt}
              AND t."endsAt" >= ${dto.createdAt}
          ),
          ins AS (
            INSERT INTO "TournamentBet" ("id", "tournamentId", "betId", "externalBetId", "playerId", "amount")
            SELECT
              gen_random_uuid()::text,
              m."id",
              ${bet.id},
              ${bet.externalBetId},
              ${bet.playerId},
              ${bet.amount}
            FROM matched m
            ON CONFLICT ("tournamentId", "externalBetId") DO NOTHING
            RETURNING "tournamentId"
          )
          SELECT
            m."id" AS "tournamentId",
            m."status"::text AS "status",
            (i."tournamentId" IS NOT NULL) AS "inserted"
          FROM matched m
          LEFT JOIN ins i ON i."tournamentId" = m."id"
        `;

        const accepted: string[] = [];
        const alreadyCounted: string[] = [];
        const increments: ScoreIncrement[] = [];

        for (const row of matched) {
          if (!row.inserted) {
            alreadyCounted.push(row.tournamentId);
            continue;
          }
          accepted.push(row.tournamentId);

          // The ledger row is written regardless — it is the audit trail. But a
          // tournament whose placements are already frozen must not have its
          // live ZSET moved; surface that as a warning instead of silently
          // dropping it.
          if (row.status === TournamentStatus.FINALIZED) {
            this.logger.warn(
              `Late bet ${bet.externalBetId} landed in already-finalized ` +
                `tournament ${row.tournamentId}; placements unchanged`,
            );
            continue;
          }
          increments.push({
            tournamentId: row.tournamentId,
            playerId: bet.playerId,
            amount: bet.amount,
          });
        }

        return { bet, accepted, alreadyCounted, increments };
      });

    // 3. Only after the ledger has committed. If the process dies here Redis
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
