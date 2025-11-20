import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { NtfySubscriptionsEntity } from './ntfy-subscriptions.entity';
import { NtfySubscriptionsService } from './ntfy-subscriptions.service';


@Global()
@Module({
    imports: [TypeOrmModule.forFeature([NtfySubscriptionsEntity])],
    providers: [NtfySubscriptionsService],
    exports: [TypeOrmModule, NtfySubscriptionsService],
})
export class NtfySubscriptionsModule { }
