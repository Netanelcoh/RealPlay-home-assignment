export const SNAPSHOT_QUEUE = 'tournament-snapshot';

export interface SnapshotJobData {
  tournamentId: string;
}

/** Stable job id -> BullMQ dedupes, so a tournament can only ever have one
 *  pending snapshot job no matter how many times scheduling is attempted. */
/** No ':' — BullMQ reserves it as its key separator and rejects custom ids
 *  containing it. */
export const snapshotJobId = (tournamentId: string): string =>
  `snapshot-${tournamentId}`;
