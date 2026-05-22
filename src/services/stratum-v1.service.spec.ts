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
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
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
      {} as any,
      {} as any,
      {} as unknown as ShareTotalsCacheService,
      { store: {} } as any,
      { isEnabled: () => false } as any,
      { isEnabled: () => false, getGroupForAddress: () => undefined } as any,
      { getRoutableGroupIdForAdmin: () => undefined } as any,
      { mark: jest.fn(), get: jest.fn() } as any,
      { incrementAccepted: jest.fn(), getChart: jest.fn() } as any,
    );
  }

  it('initializes without errors', async () => {
    const service = createService();
    await service.onModuleInit();
    // deleteAll is handled by AppService, not StratumV1Service
  });
});
