import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { bullRoot } from './queue/bull.config';
import { RedisModule } from './redis/redis.module';
import { LeaderboardService } from './tournaments/leaderboard.service';
import { SNAPSHOT_QUEUE } from './tournaments/snapshot.constants';
import { SnapshotProcessor } from './tournaments/snapshot.processor';
import { SnapshotService } from './tournaments/snapshot.service';

/** Worker app: consumes the snapshot queue. Deliberately has no HTTP surface. */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    RedisModule,
    bullRoot(),
    BullModule.registerQueue({ name: SNAPSHOT_QUEUE }),
  ],
  providers: [SnapshotProcessor, SnapshotService, LeaderboardService],
})
export class WorkerModule {}
