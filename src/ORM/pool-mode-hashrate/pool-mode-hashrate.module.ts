import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PoolModeHashrateEntity } from './pool-mode-hashrate.entity';
import { PoolModeHashrateService } from './pool-mode-hashrate.service';

@Module({
    imports: [TypeOrmModule.forFeature([PoolModeHashrateEntity])],
    providers: [PoolModeHashrateService],
    exports: [PoolModeHashrateService],
})
export class PoolModeHashrateModule {}
