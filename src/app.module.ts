import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BetsModule } from './bets/bets.module';
import { PrismaModule } from './prisma/prisma.module';
import { bullRoot } from './queue/bull.config';
import { RedisModule } from './redis/redis.module';
import { TournamentsModule } from './tournaments/tournaments.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    RedisModule,
    bullRoot(),
    TournamentsModule,
    BetsModule,
  ],
})
export class AppModule {}
