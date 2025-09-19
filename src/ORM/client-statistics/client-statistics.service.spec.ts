import { ClientStatisticsService } from './client-statistics.service';

describe('ClientStatisticsService - getChartDataForGroup', () => {
  it('returns chart data including accepted shares aggregated over the requested range', async () => {
    const queryMock = jest.fn().mockResolvedValue([
      { label: 1700000000000, data: '123.5', accepted: '10', rejected: '2' },
      { label: 1700000600000, data: '456.75', accepted: '20', rejected: '3' },
    ]);
    const service = new ClientStatisticsService({ query: queryMock } as any);
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1700003600000);

    try {
      const result = await service.getChartDataForGroup('address', 'worker', '3d');

      expect(queryMock).toHaveBeenCalledTimes(1);
      const queryString = queryMock.mock.calls[0][0] as string;
      expect(queryString).toContain('SUM(entry.acceptedCount) AS accepted');
      expect(queryString).toContain('SUM(entry.rejectedCount) AS rejected');
      expect(queryString).toContain('LIMIT 432;');

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        label: new Date(1700000000000).toISOString(),
        data: 123.5,
        accepted: 10,
        rejected: 2,
      });
    } finally {
      nowSpy.mockRestore();
    }
  });
});
