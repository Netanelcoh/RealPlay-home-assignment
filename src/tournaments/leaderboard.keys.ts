/** Redis ZSET holding the live ranking for one tournament.
 *  member = playerId, score = running sum of accepted bet amounts (cents). */
export const leaderboardKey = (tournamentId: string): string =>
  `leaderboard:${tournamentId}`;
