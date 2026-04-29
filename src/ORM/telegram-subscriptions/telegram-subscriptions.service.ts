import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TelegramSubscriptionsEntity } from './telegram-subscriptions.entity';


@Injectable()
export class TelegramSubscriptionsService {
    constructor(
        @InjectRepository(TelegramSubscriptionsEntity)
        private telegramSubscriptions: Repository<TelegramSubscriptionsEntity>
    ) {}

    public async getSubscriptions(address: string) {
        return await this.telegramSubscriptions.find({ where: { address } });
    }

    public async getChatSubscriptions(chatId: number) {
        return await this.telegramSubscriptions.find({ where: { telegramChatId: chatId } });
    }

    public async getDefault(chatId: number) {
        return await this.telegramSubscriptions.findOneBy({ telegramChatId: chatId, isDefault: true });
    }

    public async saveSubscription(chatId: number, address: string) {
        await this.telegramSubscriptions.update({ telegramChatId: chatId }, { isDefault: false });
        const existing = await this.telegramSubscriptions.findOne({ where: { telegramChatId: chatId, address } });
        if (existing) {
            return await this.telegramSubscriptions.update({ telegramChatId: chatId, address }, { isDefault: true });
        }
        const previous = await this.telegramSubscriptions.findOne({ where: { telegramChatId: chatId } });
        return await this.telegramSubscriptions.save({
            telegramChatId: chatId,
            address,
            isDefault: true,
            bestDiffNotificationsEnabled: previous?.bestDiffNotificationsEnabled ?? true,
            deviceNotificationsEnabled: previous?.deviceNotificationsEnabled ?? false
        });
    }

    /**
     * Removes a subscription. Returns true if a row was actually deleted,
     * false if no matching row existed. Callers use this to give the user
     * an honest reply (the previous version always said "removed" even
     * when nothing matched, masking a bot/DB hiccup we observed once
     * in production).
     */
    public async removeSubscription(chatId: number, address: string): Promise<boolean> {
        const result = await this.telegramSubscriptions.delete({ telegramChatId: chatId, address });
        const removed = (result.affected ?? 0) > 0;
        if (!removed) return false;

        const remaining = await this.getChatSubscriptions(chatId);
        if (remaining.length > 0 && !remaining.some(r => r.isDefault)) {
            await this.telegramSubscriptions.update({ id: remaining[0].id }, { isDefault: true });
        }
        return true;
    }

    public async updateBestDiffNotification(chatId: number, enabled: boolean): Promise<void> {
        await this.telegramSubscriptions.update(
            { telegramChatId: chatId },
            { bestDiffNotificationsEnabled: enabled }
        );
    }

    public async updateDeviceNotifications(chatId: number, enabled: boolean): Promise<void> {
        await this.telegramSubscriptions.update(
            { telegramChatId: chatId },
            { deviceNotificationsEnabled: enabled }
        );
    }

    public async updateHourlyNotifications(
        chatId: number,
        enabled: boolean,
        showStats: boolean,
        showWorkers: boolean
    ): Promise<void> {
        await this.telegramSubscriptions.update(
            { telegramChatId: chatId },
            {
                hourlyStatsEnabled: enabled && showStats,
                hourlyWorkersEnabled: enabled && showWorkers
            }
        );
    }

    public async getHourlyEnabledChats(): Promise<TelegramSubscriptionsEntity[]> {
        return await this.telegramSubscriptions
            .createQueryBuilder('sub')
            .where('sub.hourlyStatsEnabled = :true OR sub.hourlyWorkersEnabled = :true', { true: true })
            .andWhere('sub.isDefault = :true', { true: true })
            .andWhere('sub.telegramChatId IS NOT NULL')
            .getMany();
    }

    public async getAllAddresses(): Promise<string[]> {
        const rows = await this.telegramSubscriptions
            .createQueryBuilder('sub')
            .where('sub.telegramChatId IS NOT NULL')
            .select('DISTINCT sub.address', 'address')
            .getRawMany();
        return rows.map(r => r.address);
    }
}
