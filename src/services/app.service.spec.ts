import { AppService } from './app.service';

describe('AppService.onModuleInit', () => {
  let dataSource: { query: jest.Mock };
  let clientService: {
    deleteAll: jest.Mock;
    killDeadClients: jest.Mock;
    deleteOldClients: jest.Mock;
  };
  let clientStatisticsService: { deleteOldStatistics: jest.Mock };
  let rpcBlockService: { deleteOldBlocks: jest.Mock };
  let setIntervalSpy: jest.SpyInstance;

  beforeEach(() => {
    dataSource = { query: jest.fn().mockResolvedValue(undefined) };
    clientService = {
      deleteAll: jest.fn().mockResolvedValue(undefined),
      killDeadClients: jest.fn().mockResolvedValue(undefined),
      deleteOldClients: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    clientStatisticsService = {
      deleteOldStatistics: jest.fn().mockResolvedValue(undefined),
    };
    rpcBlockService = {
      deleteOldBlocks: jest.fn().mockResolvedValue(undefined),
    };
    setIntervalSpy = jest
      .spyOn(global, 'setInterval')
      .mockReturnValue(null as unknown as NodeJS.Timeout);
    delete process.env.NODE_APP_INSTANCE;
  });

  afterEach(() => {
    setIntervalSpy.mockRestore();
    delete process.env.NODE_APP_INSTANCE;
  });

  function createService() {
    return new AppService(
      clientStatisticsService as any,
      clientService as any,
      dataSource as any,
      rpcBlockService as any,
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
