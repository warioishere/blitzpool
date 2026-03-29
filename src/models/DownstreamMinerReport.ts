import { IsArray, IsInt, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class DownstreamMiner {
  @IsString()
  vendor: string;

  @IsOptional()
  @IsString()
  hardwareVersion?: string;

  @IsOptional()
  @IsString()
  firmware?: string;

  @IsOptional()
  @IsString()
  deviceId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  nominalHashRate?: number;

  @IsOptional()
  @IsString()
  userIdentity?: string;

  @IsOptional()
  @IsString()
  connectedAt?: string;
}

export class DownstreamMinerReport {
  @IsInt()
  @Min(1)
  schemaVersion: number;

  @IsString()
  jdcUserIdentity: string;

  @IsString()
  timestamp: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DownstreamMiner)
  miners: DownstreamMiner[];
}
