import { Type } from 'class-transformer';
import {
  IsDate,
  IsInt,
  IsNotEmpty,
  IsString,
  Length,
  Min,
} from 'class-validator';

export class CreateBetDto {
  @IsString()
  @IsNotEmpty()
  externalBetId!: string;

  @IsString()
  @IsNotEmpty()
  playerId!: string;

  /** Cents. 250 === $2.50. */
  @IsInt()
  @Min(0)
  amount!: number;

  @IsString()
  @Length(3, 3)
  currency!: string;

  /** Event time — when the bet happened, not when it reached us. Tournament
   *  windows are matched against this, so a late-arriving bet still counts. */
  @Type(() => Date)
  @IsDate()
  createdAt!: Date;
}
