-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TournamentStatus" AS ENUM ('SCHEDULED', 'FINALIZED');

-- CreateTable
CREATE TABLE "Tournament" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" "TournamentStatus" NOT NULL DEFAULT 'SCHEDULED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tournament_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bet" (
    "id" TEXT NOT NULL,
    "externalBetId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Bet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TournamentBet" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "betId" TEXT NOT NULL,
    "externalBetId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TournamentBet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TournamentPlacement" (
    "tournamentId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "rank" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TournamentPlacement_pkey" PRIMARY KEY ("tournamentId","playerId")
);

-- CreateIndex
CREATE INDEX "Tournament_startsAt_endsAt_idx" ON "Tournament"("startsAt", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "Bet_externalBetId_key" ON "Bet"("externalBetId");

-- CreateIndex
CREATE INDEX "Bet_playerId_idx" ON "Bet"("playerId");

-- CreateIndex
CREATE INDEX "TournamentBet_tournamentId_playerId_idx" ON "TournamentBet"("tournamentId", "playerId");

-- CreateIndex
CREATE UNIQUE INDEX "TournamentBet_tournamentId_externalBetId_key" ON "TournamentBet"("tournamentId", "externalBetId");

-- CreateIndex
CREATE INDEX "TournamentPlacement_tournamentId_rank_idx" ON "TournamentPlacement"("tournamentId", "rank");

-- AddForeignKey
ALTER TABLE "TournamentBet" ADD CONSTRAINT "TournamentBet_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentBet" ADD CONSTRAINT "TournamentBet_betId_fkey" FOREIGN KEY ("betId") REFERENCES "Bet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentPlacement" ADD CONSTRAINT "TournamentPlacement_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

