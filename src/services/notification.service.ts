import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { Block } from 'bitcoinjs-lib';

import { TelegramService } from './telegram.service';
import { NtfyService } from './ntfy.service';
import { PushNotificationService } from './push-notification.service';


@Injectable()
export class NotificationService {

    constructor(
        @Inject(forwardRef(() => TelegramService))
        private readonly telegramService: TelegramService,
        private readonly ntfyService: NtfyService,
        private readonly pushNotificationService: PushNotificationService,
    ) { }

    public async notifySubscribersBlockFound(address: string, height: number, block: Block, message: string) {
        // Fan-out parallel — slow transport doesn't block faster ones.
        await Promise.all([
            this.telegramService.notifySubscribersBlockFound(address, height, block, message),
            this.ntfyService.notifySubscribersBlockFound(address, height, block, message),
            this.pushNotificationService.notifySubscribersBlockFound(address, height, block, message),
        ]);
    }

    public async notifySubscribersBestDiff(address: string, submissionDifficulty: number) {
        await Promise.all([
            this.telegramService.notifySubscribersBestDiff(address, submissionDifficulty),
            this.ntfyService.notifySubscribersBestDiff(address, submissionDifficulty),
        ]);
    }

    public async notifyDeviceStatusChange(params: {
        address: string;
        workerName?: string;
        userAgent?: string;
        sessionId: string;
        isOnline: boolean;
        timestamp: Date;
        isReturning?: boolean;
    }): Promise<void> {
        await Promise.all([
            this.telegramService.notifyDeviceStatusChange(params),
            this.pushNotificationService.notifyDeviceStatusChange(params),
        ]);
    }
}
