import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { LeaderboardService } from './leaderboard.service';
import { SNAPSHOT_QUEUE } from './snapshot.constants';
import { TournamentsController } from './tournaments.controller';
import { TournamentsService } from './tournaments.service';

/** API side only: registers the queue as a *producer*. The processor lives in
 *  the worker app so the two scale and fail independently. */
@Module({
  imports: [BullModule.registerQueue({ name: SNAPSHOT_QUEUE })],
  controllers: [TournamentsController],
  providers: [TournamentsService, LeaderboardService],
  exports: [LeaderboardService],
})
export class TournamentsModule {}
