import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Tournament, TournamentStatus } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTournamentDto } from './dto/create-tournament.dto';
import { LeaderboardRow, LeaderboardService } from './leaderboard.service';
import {
  SNAPSHOT_QUEUE,
  SnapshotJobData,
  snapshotJobId,
} from './snapshot.constants';

export interface LeaderboardPage {
  tournamentId: string;
  status: TournamentStatus;
  /** 'live' = ranked from Redis; 'final' = frozen placements from Postgres. */
  source: 'live' | 'final';
  total: number;
  limit: number;
  offset: number;
  rows: LeaderboardRow[];
}

@Injectable()
export class TournamentsService {
  private readonly logger = new Logger(TournamentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly leaderboard: LeaderboardService,
    @InjectQueue(SNAPSHOT_QUEUE) private readonly snapshotQueue: Queue,
  ) {}

  async create(dto: CreateTournamentDto): Promise<Tournament> {
    if (dto.endsAt <= dto.startsAt) {
      throw new BadRequestException('endsAt must be after startsAt');
    }

    const tournament = await this.prisma.tournament.create({
      data: { name: dto.name, startsAt: dto.startsAt, endsAt: dto.endsAt },
    });

    await this.scheduleSnapshot(tournament);
    return tournament;
  }

  /** Delayed job fires once endsAt passes. The stable jobId means BullMQ drops
   *  duplicate schedule attempts, so this is safe to call more than once. */
  private async scheduleSnapshot(tournament: Tournament): Promise<void> {
    const delay = Math.max(0, tournament.endsAt.getTime() - Date.now());

    await this.snapshotQueue.add(
      'snapshot',
      { tournamentId: tournament.id } satisfies SnapshotJobData,
      {
        jobId: snapshotJobId(tournament.id),
        delay,
        removeOnComplete: true,
        removeOnFail: false,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
      },
    );

    this.logger.log(
      `Scheduled snapshot for tournament ${tournament.id} in ${delay}ms`,
    );
  }

  async getLeaderboard(
    tournamentId: string,
    limit: number,
    offset: number,
  ): Promise<LeaderboardPage> {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
      select: { id: true, status: true },
    });
    if (!tournament) {
      throw new NotFoundException(`Tournament ${tournamentId} not found`);
    }

    // Once finalized, the frozen placements are the answer — the Redis key is
    // gone by then, and the published result must not shift.
    if (tournament.status === TournamentStatus.FINALIZED) {
      const [placements, total] = await Promise.all([
        this.prisma.tournamentPlacement.findMany({
          where: { tournamentId },
          orderBy: { rank: 'asc' },
          skip: offset,
          take: limit,
          select: { playerId: true, score: true, rank: true },
        }),
        this.prisma.tournamentPlacement.count({ where: { tournamentId } }),
      ]);

      return {
        tournamentId,
        status: tournament.status,
        source: 'final',
        total,
        limit,
        offset,
        rows: placements,
      };
    }

    const { rows, total } = await this.leaderboard.page(
      tournamentId,
      limit,
      offset,
    );

    return {
      tournamentId,
      status: tournament.status,
      source: 'live',
      total,
      limit,
      offset,
      rows,
    };
  }
}
