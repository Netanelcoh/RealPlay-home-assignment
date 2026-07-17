import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Tournament } from '@prisma/client';
import { CreateTournamentDto } from './dto/create-tournament.dto';
import { LeaderboardQueryDto } from './dto/leaderboard-query.dto';
import { LeaderboardPage, TournamentsService } from './tournaments.service';

@Controller('tournaments')
export class TournamentsController {
  constructor(private readonly tournaments: TournamentsService) {}

  @Post()
  create(@Body() dto: CreateTournamentDto): Promise<Tournament> {
    return this.tournaments.create(dto);
  }

  @Get(':id/leaderboard')
  leaderboard(
    @Param('id') id: string,
    @Query() query: LeaderboardQueryDto,
  ): Promise<LeaderboardPage> {
    return this.tournaments.getLeaderboard(id, query.limit, query.offset);
  }
}
