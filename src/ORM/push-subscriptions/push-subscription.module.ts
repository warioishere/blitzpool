import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PushSubscriptionEntity } from './push-subscription.entity';
import { PushSubscriptionService } from './push-subscription.service';


@Global()
@Module({
    imports: [TypeOrmModule.forFeature([PushSubscriptionEntity])],
    providers: [PushSubscriptionService],
    exports: [TypeOrmModule, PushSubscriptionService],
})
export class PushSubscriptionModule { }
