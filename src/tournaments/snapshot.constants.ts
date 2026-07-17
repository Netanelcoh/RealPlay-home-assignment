export const SNAPSHOT_QUEUE = 'tournament-snapshot';

export interface SnapshotJobData {
  tournamentId: string;
}

/** Stable job id -> BullMQ dedupes, so a tournament can only ever have one
 *  pending snapshot job no matter how many times scheduling is attempted. */
export const snapshotJobId = (tournamentId: string): string =>
  `snapshot:${tournamentId}`;
