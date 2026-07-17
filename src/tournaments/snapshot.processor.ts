import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { SNAPSHOT_QUEUE, SnapshotJobData } from './snapshot.constants';
import { SnapshotService } from './snapshot.service';

@Processor(SNAPSHOT_QUEUE)
export class SnapshotProcessor extends WorkerHost {
  private readonly logger = new Logger(SnapshotProcessor.name);

  constructor(private readonly snapshots: SnapshotService) {
    super();
  }

  async process(job: Job<SnapshotJobData>): Promise<{ players: number }> {
    this.logger.log(`Running snapshot for tournament ${job.data.tournamentId}`);
    return this.snapshots.finalize(job.data.tournamentId);
  }
}
