import { ConfigService } from '@nestjs/config';

jest.mock('web-push', () => ({
    setVapidDetails: jest.fn(),
    sendNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('axios', () => ({
    post: jest.fn().mockResolvedValue({ status: 200 }),
    get: jest.fn(),
}));

import { PushNotificationService } from './push-notification.service';

/**
 * checkBestDifficulty was doing 2N sequential PG round-trips per cron tick
 * (getSettings + getTracker per address). Verify the bulk path: 2 round-
 * trips total (one IN-list each), then one bulk tracker upsert + parallel
 * notification fan-out.
 */
function buildService(overrides: {
    addresses?: string[];
    settings: Map<string, number>;
    trackers: Map<string, { address: string; bestDifficulty: number }>;
}) {
    const pushSubscriptionService: any = {
        getCachedAddressesWithSubscriptions: () => overrides.addresses ?? null,
        getAddressesWithSubscriptions: async () => overrides.addresses ?? [],
        hasAnySubscription: () => false,
        getUnifiedPushByAddressWithBestDiffNotifications: async () => [],
        getFcmByAddressWithBestDiffNotifications: async () => [],
    };
    const addressSettingsService: any = {
        getBestDifficultiesForAddresses: jest.fn(async () => overrides.settings),
    };
    const trackerService: any = {
        getTrackersForAddresses: jest.fn(async () => overrides.trackers),
        updateTrackersBulk: jest.fn(async () => undefined),
    };
    const networkDiffTrackerService: any = {
        getTracker: jest.fn(),
        updateTracker: jest.fn(),
    };
    const fcmService: any = { sendNotification: jest.fn(async () => ({ success: true })) };
    const configService = { get: jest.fn() } as unknown as ConfigService;

    const service = new PushNotificationService(
        configService,
        pushSubscriptionService,
        trackerService,
        networkDiffTrackerService,
        addressSettingsService,
        fcmService,
    );
    return { service, addressSettingsService, trackerService };
}

describe('PushNotificationService.checkBestDifficulty', () => {
    it('fetches settings and trackers exactly once each, regardless of address count', async () => {
        const addresses = ['addr-A', 'addr-B', 'addr-C', 'addr-D'];
        const settings = new Map(addresses.map(a => [a, 100]));
        const trackers = new Map(addresses.map(a => [a, { address: a, bestDifficulty: 90 }]));
        const { service, addressSettingsService, trackerService } = buildService({
            addresses, settings, trackers,
        });

        await service.checkBestDifficulty();

        expect(addressSettingsService.getBestDifficultiesForAddresses).toHaveBeenCalledTimes(1);
        expect(addressSettingsService.getBestDifficultiesForAddresses).toHaveBeenCalledWith(addresses);
        expect(trackerService.getTrackersForAddresses).toHaveBeenCalledTimes(1);
        expect(trackerService.getTrackersForAddresses).toHaveBeenCalledWith(addresses);
    });

    it('issues exactly one bulk tracker upsert containing only changed rows', async () => {
        const addresses = ['addr-Up', 'addr-Same', 'addr-Init', 'addr-Down'];
        const settings = new Map([
            ['addr-Up', 200], // > tracker → notify + update
            ['addr-Same', 100], // = tracker → no-op
            ['addr-Init', 50],  // no tracker → init only (no notify)
            ['addr-Down', 80],  // < tracker → silent sync down
        ]);
        const trackers = new Map([
            ['addr-Up', { address: 'addr-Up', bestDifficulty: 100 }],
            ['addr-Same', { address: 'addr-Same', bestDifficulty: 100 }],
            ['addr-Down', { address: 'addr-Down', bestDifficulty: 100 }],
        ]);
        const { service, trackerService } = buildService({ addresses, settings, trackers });

        await service.checkBestDifficulty();

        expect(trackerService.updateTrackersBulk).toHaveBeenCalledTimes(1);
        const upserted = trackerService.updateTrackersBulk.mock.calls[0][0];
        const addrs = upserted.map((r: any) => r.address).sort();
        expect(addrs).toEqual(['addr-Down', 'addr-Init', 'addr-Up']);
    });

    it('skips addresses with no AddressSettings row entirely', async () => {
        const addresses = ['addr-A', 'addr-Missing'];
        const settings = new Map([['addr-A', 100]]); // addr-Missing absent
        const trackers = new Map();
        const { service, trackerService } = buildService({ addresses, settings, trackers });

        await service.checkBestDifficulty();

        expect(trackerService.updateTrackersBulk).toHaveBeenCalledTimes(1);
        const upserted = trackerService.updateTrackersBulk.mock.calls[0][0];
        expect(upserted.map((r: any) => r.address)).toEqual(['addr-A']);
    });

    it('no upsert when nothing changed', async () => {
        const addresses = ['addr-A'];
        const settings = new Map([['addr-A', 100]]);
        const trackers = new Map([['addr-A', { address: 'addr-A', bestDifficulty: 100 }]]);
        const { service, trackerService } = buildService({ addresses, settings, trackers });

        await service.checkBestDifficulty();
        expect(trackerService.updateTrackersBulk).not.toHaveBeenCalled();
    });

    it('empty subscriber list is an early-return no-op', async () => {
        const { service, addressSettingsService, trackerService } = buildService({
            addresses: [],
            settings: new Map(),
            trackers: new Map(),
        });
        await service.checkBestDifficulty();
        expect(addressSettingsService.getBestDifficultiesForAddresses).not.toHaveBeenCalled();
        expect(trackerService.getTrackersForAddresses).not.toHaveBeenCalled();
        expect(trackerService.updateTrackersBulk).not.toHaveBeenCalled();
    });
});
