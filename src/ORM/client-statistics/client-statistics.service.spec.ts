import { ClientStatisticsService } from './client-statistics.service';

describe('ClientStatisticsService hashrate calculations', () => {
  const repo: any = { query: jest.fn() };
  const service = new ClientStatisticsService(repo);

  afterEach(() => {
    repo.query.mockReset();
  });

  it('computes consistent hashrate for session and group', async () => {
    const data = [
      {
        createdAt: new Date('2023-01-01T00:00:00Z').toISOString(),
        updatedAt: new Date('2023-01-01T00:10:00Z').toISOString(),
        shares: 10,
      },
      {
        createdAt: new Date('2022-12-31T23:50:00Z').toISOString(),
        updatedAt: new Date('2022-12-31T23:59:00Z').toISOString(),
        shares: 20,
      },
    ];

    repo.query.mockResolvedValueOnce(data);
    const sessionRate = await service.getHashRateForSession(
      'addr',
      'worker',
      'sess',
    );

    repo.query.mockResolvedValueOnce(data);
    const groupRate = await service.getHashRateForGroup('addr', 'worker');

    expect(groupRate).toBeCloseTo(sessionRate);
  });

  it('returns zero when timespan is below one minute', async () => {
    const short = [
      {
        createdAt: new Date('2023-01-01T00:00:00Z').toISOString(),
        updatedAt: new Date('2023-01-01T00:00:30Z').toISOString(),
        shares: 5,
      },
    ];

    repo.query.mockResolvedValueOnce(short);
    const sessionRate = await service.getHashRateForSession('a', 'b', 'c');
    expect(sessionRate).toBe(0);

    repo.query.mockResolvedValueOnce(short);
    const groupRate = await service.getHashRateForGroup('a', 'b');
    expect(groupRate).toBe(0);
  });
});
