import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';

jest.mock('node-telegram-bot-api', () => ({}));

import { ClientController } from './client.controller';
import { ClientService } from '../../ORM/client/client.service';
import { ClientStatisticsService } from '../../ORM/client-statistics/client-statistics.service';
import { AddressSettingsService } from '../../ORM/address-settings/address-settings.service';
import { ClientRejectedStatisticsService } from '../../ORM/client-rejected-statistics/client-rejected-statistics.service';
import { StratumV1Service } from '../../services/stratum-v1.service';
import { ClientDifficultyStatisticsService } from '../../ORM/client-difficulty-statistics/client-difficulty-statistics.service';

describe('ClientController difficulty scores', () => {
  let app: NestFastifyApplication;
  let clientDifficultyStatisticsService: {
    getMaximaForAddress: jest.Mock;
  };
  let dateNowSpy: jest.SpyInstance<number, []>;

  beforeEach(async () => {
    clientDifficultyStatisticsService = {
      getMaximaForAddress: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ClientController],
      providers: [
        { provide: ClientService, useValue: {} },
        { provide: ClientStatisticsService, useValue: {} },
        { provide: AddressSettingsService, useValue: {} },
        { provide: ClientRejectedStatisticsService, useValue: {} },
        { provide: ClientDifficultyStatisticsService, useValue: clientDifficultyStatisticsService },
        { provide: StratumV1Service, useValue: {} },
      ],
    }).compile();

    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    await app.init();

    dateNowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.UTC(2023, 0, 31, 12, 34, 0, 0));
  });

  afterEach(async () => {
    dateNowSpy.mockRestore();
    await app.close();
  });

  it('returns hourly difficulty maxima for the requested range', async () => {
    const oneHour = 60 * 60 * 1000;
    const now = Date.now();
    const hours = 7 * 24;
    const startSlot = Math.floor((now - hours * oneHour) / oneHour) * oneHour;
    const endSlot = Math.floor(now / oneHour) * oneHour;

    clientDifficultyStatisticsService.getMaximaForAddress.mockResolvedValue([
      { slotTime: startSlot, maxDifficulty: 42 },
      { slotTime: startSlot + 2 * oneHour, maxDifficulty: 99 },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/client/addr123/diff-scores?range=7d',
    });

    expect(res.statusCode).toBe(200);

    expect(clientDifficultyStatisticsService.getMaximaForAddress).toHaveBeenCalledWith(
      'addr123',
      startSlot,
      endSlot,
    );

    const payload = JSON.parse(res.payload);
    expect(payload.slotData[0]).toEqual({
      time: new Date(startSlot).toISOString(),
      difficulty: 42,
    });
    expect(payload.slotData[1]).toEqual({
      time: new Date(startSlot + oneHour).toISOString(),
      difficulty: 0,
    });
    expect(payload.slotData[2]).toEqual({
      time: new Date(startSlot + 2 * oneHour).toISOString(),
      difficulty: 99,
    });
    expect(payload.slotData[payload.slotData.length - 1]).toEqual({
      time: new Date(endSlot).toISOString(),
      difficulty: 0,
    });
  });

  it('defaults to returning one day of data when no range is specified', async () => {
    clientDifficultyStatisticsService.getMaximaForAddress.mockResolvedValue([]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/client/addr123/diff-scores',
    });

    expect(res.statusCode).toBe(200);

    const call =
      clientDifficultyStatisticsService.getMaximaForAddress.mock.calls[
        clientDifficultyStatisticsService.getMaximaForAddress.mock.calls.length - 1
      ];
    const [address, start, end] = call;
    expect(address).toBe('addr123');
    const oneHour = 60 * 60 * 1000;
    const now = Date.now();
    const expectedStart = Math.floor((now - 24 * oneHour) / oneHour) * oneHour;
    const expectedEnd = Math.floor(now / oneHour) * oneHour;
    expect(start).toBe(expectedStart);
    expect(end).toBe(expectedEnd);

    const payload = JSON.parse(res.payload);
    expect(Array.isArray(payload.slotData)).toBe(true);
  });
});
