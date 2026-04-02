import { AppService } from './app.service';

describe('AppService.onModuleInit', () => {
  let dataSource: { query: jest.Mock; synchronize: jest.Mock; options?: { type?: string } };
  let clientService: {
    deleteAll: jest.Mock;
    killDeadClients: jest.Mock;
    deleteOldClients: jest.Mock;
  };
  let clientStatisticsService: { deleteOldStatistics: jest.Mock };
  let clientDifficultyStatisticsService: { deleteOlderThan: jest.Mock };
  let rpcBlockService: { deleteOldBlocks: jest.Mock };
  let configService: { get: jest.Mock };
  let setIntervalSpy: jest.SpyInstance;

  beforeEach(() => {
    dataSource = {
      query: jest.fn().mockResolvedValue(undefined),
      synchronize: jest.fn().mockResolvedValue(undefined),
      options: { type: 'sqlite' },
    };
    clientService = {
      deleteAll: jest.fn().mockResolvedValue(undefined),
      killDeadClients: jest.fn().mockResolvedValue(undefined),
      deleteOldClients: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    clientStatisticsService = {
      deleteOldStatistics: jest.fn().mockResolvedValue(undefined),
    };
    clientDifficultyStatisticsService = {
      deleteOlderThan: jest.fn().mockResolvedValue(undefined),
    };
    rpcBlockService = {
      deleteOldBlocks: jest.fn().mockResolvedValue(undefined),
    };
    configService = {
      get: jest.fn().mockReturnValue(undefined),
    };
    setIntervalSpy = jest
      .spyOn(global, 'setInterval')
      .mockReturnValue(null as unknown as NodeJS.Timeout);
  });

  afterEach(() => {
    setIntervalSpy.mockRestore();
  });

  function createService() {
    return new AppService(
      {} as any, // cacheManager
      clientStatisticsService as any,
      clientDifficultyStatisticsService as any,
      clientService as any,
      dataSource as any,
      rpcBlockService as any,
      configService as any,
    );
  }

  it('clears clients on startup', async () => {
    const service = createService();

    await service.onModuleInit();

    expect(clientService.deleteAll).toHaveBeenCalledTimes(1);
  });

  it('synchronizes the schema when enabled for postgres', async () => {
    dataSource.options = { type: 'postgres' };
    configService.get.mockImplementation((key: string) =>
      key === 'DB_AUTO_SYNCHRONIZE' ? 'true' : undefined,
    );
    const service = createService();

    await service.onModuleInit();

    expect(dataSource.synchronize).toHaveBeenCalledTimes(1);
  });
});
