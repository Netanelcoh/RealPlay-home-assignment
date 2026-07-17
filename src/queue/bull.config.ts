import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { DynamicModule } from '@nestjs/common';

/** Shared BullMQ connection, imported by both the API (producer) and the
 *  worker (consumer) so they agree on the same Redis. */
export const bullRoot = (): DynamicModule =>
  BullModule.forRootAsync({
    inject: [ConfigService],
    useFactory: (config: ConfigService) => ({
      connection: {
        host: config.get<string>('REDIS_HOST', 'localhost'),
        port: config.get<number>('REDIS_PORT', 6379),
      },
    }),
  });
