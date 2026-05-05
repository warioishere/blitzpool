import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PoolModeHashrateEntity } from './pool-mode-hashrate.entity';
import { PoolModeHashrateService } from './pool-mode-hashrate.service';

@Global()
@Module({
    imports: [TypeOrmModule.forFeature([PoolModeHashrateEntity])],
    providers: [PoolModeHashrateService],
    exports: [TypeOrmModule, PoolModeHashrateService],
})
export class PoolModeHashrateModule {}
