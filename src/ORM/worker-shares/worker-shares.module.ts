import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WorkerSharesEntity } from './worker-shares.entity';
import { WorkerSharesService } from './worker-shares.service';

@Module({
    imports: [TypeOrmModule.forFeature([WorkerSharesEntity])],
    providers: [WorkerSharesService],
    exports: [WorkerSharesService],
})
export class WorkerSharesModule {}
