jest.mock('node-telegram-bot-api', () => jest.fn());

import { StratumV1Service } from './stratum-v1.service';
import { ShareTotalsCacheService } from './share-totals-cache.service';

describe('StratumV1Service.onModuleInit', () => {
  let clientService: { deleteAll: jest.Mock };
  let setTimeoutSpy: jest.SpyInstance;

  beforeEach(() => {
    clientService = { deleteAll: jest.fn().mockResolvedValue(undefined) };
    setTimeoutSpy = jest
      .spyOn(global, 'setTimeout')
      .mockReturnValue(null as unknown as NodeJS.Timeout);
    delete process.env.NODE_APP_INSTANCE;
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
    delete process.env.NODE_APP_INSTANCE;
  });

  function createService() {
    return new StratumV1Service(
      {} as any,
      clientService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as unknown as ShareTotalsCacheService,
    );
  }

  it('clears clients when running as a single instance', async () => {
    const service = createService();

    await service.onModuleInit();

    expect(clientService.deleteAll).toHaveBeenCalledTimes(1);
  });

  it('skips clearing clients when NODE_APP_INSTANCE is set', async () => {
    process.env.NODE_APP_INSTANCE = '1';
    const service = createService();

    await service.onModuleInit();

    expect(clientService.deleteAll).not.toHaveBeenCalled();
  });
});
