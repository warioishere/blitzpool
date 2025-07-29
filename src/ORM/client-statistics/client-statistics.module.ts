import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ClientStatisticsEntity } from './client-statistics.entity';
import { ClientStatisticsService } from './client-statistics.service';
import { ClientModule } from '../client/client.module';


@Global()
@Module({
    imports: [TypeOrmModule.forFeature([ClientStatisticsEntity]), ClientModule],
    providers: [ClientStatisticsService],
    exports: [TypeOrmModule, ClientStatisticsService],
})
export class ClientStatisticsModule { }