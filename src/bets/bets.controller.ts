import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { BetsService, IngestResult } from './bets.service';
import { CreateBetDto } from './dto/create-bet.dto';

@Controller('bet')
export class BetsController {
  constructor(private readonly bets: BetsService) {}

  /** Idempotent: replaying an externalBetId returns the same 200 with the same
   *  shape and does not move any score. Duplicates are success, never an error. */
  @Post()
  @HttpCode(HttpStatus.OK)
  create(@Body() dto: CreateBetDto): Promise<IngestResult> {
    return this.bets.ingest(dto);
  }
}
