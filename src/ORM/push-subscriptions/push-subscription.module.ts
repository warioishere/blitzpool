import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PushSubscriptionEntity } from './push-subscription.entity';
import { PushSubscriptionService } from './push-subscription.service';
import { PushSubscriptionCleanupService } from './push-subscription-cleanup.service';


@Global()
@Module({
    imports: [TypeOrmModule.forFeature([PushSubscriptionEntity])],
    providers: [PushSubscriptionService, PushSubscriptionCleanupService],
    exports: [TypeOrmModule, PushSubscriptionService, PushSubscriptionCleanupService],
})
export class PushSubscriptionModule { }
