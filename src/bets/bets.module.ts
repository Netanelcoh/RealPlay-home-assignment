import { Module } from '@nestjs/common';
import { LeaderboardService } from '../tournaments/leaderboard.service';
import { BetsController } from './bets.controller';
import { BetsService } from './bets.service';

@Module({
  controllers: [BetsController],
  providers: [BetsService, LeaderboardService],
})
export class BetsModule {}
