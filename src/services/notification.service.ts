import { Injectable, OnModuleInit } from '@nestjs/common';
import { Block } from 'bitcoinjs-lib';

import { DiscordService } from './discord.service';
import { TelegramService } from './telegram.service';
import { NtfyService } from './ntfy.service';


@Injectable()
export class NotificationService implements OnModuleInit {

    constructor(
        private readonly telegramService: TelegramService,
        private readonly discordService: DiscordService,
        private readonly ntfyService: NtfyService,
    ) { }

    async onModuleInit(): Promise<void> {
        await this.discordService.notifyRestarted();
    }

    public async notifySubscribersBlockFound(address: string, height: number, block: Block, message: string) {
        await this.discordService.notifySubscribersBlockFound(height, block, message);
        await this.telegramService.notifySubscribersBlockFound(address, height, block, message);
        await this.ntfyService.notifySubscribersBlockFound(address, height, block, message);
    }

    public async notifySubscribersBestDiff(address: string, submissionDifficulty: number) {
        await this.discordService.notifySubscribersBestDiff(submissionDifficulty);
        await this.telegramService.notifySubscribersBestDiff(address, submissionDifficulty);
        await this.ntfyService.notifySubscribersBestDiff(address, submissionDifficulty);
    }
}