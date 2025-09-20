import { ClientStatisticsService } from './client-statistics.service';

describe('ClientStatisticsService - getChartDataForGroup', () => {
  it('returns chart data including accepted shares aggregated over the requested range', async () => {
    const queryMock = jest.fn().mockResolvedValue([
      {
        label: 1700000000000,
        data: '123.5',
        accepted: '10',
        rejectedJobNotFound: '1',
        rejectedJobNotFoundDiff1: '4000',
        rejectedDuplicatedShare: '2',
        rejectedDuplicatedShareDiff1: '8000',
        rejectedLowDifficultyShare: '3',
        rejectedLowDifficultyShareDiff1: '12000',
      },
      {
        label: 1700000600000,
        data: '456.75',
        accepted: '20',
        rejectedJobNotFound: '0',
        rejectedJobNotFoundDiff1: '0',
        rejectedDuplicatedShare: '1',
        rejectedDuplicatedShareDiff1: '2000',
        rejectedLowDifficultyShare: '4',
        rejectedLowDifficultyShareDiff1: '16000',
      },
    ]);
    const service = new ClientStatisticsService({ query: queryMock } as any);
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1700003600000);

    try {
      const result = await service.getChartDataForGroup('address', 'worker', '3d');

      expect(queryMock).toHaveBeenCalledTimes(1);
      const queryString = queryMock.mock.calls[0][0] as string;
      expect(queryString).toContain('SUM(entry.acceptedCount) AS accepted');
      expect(queryString).toContain(
        'SUM(entry.rejectedJobNotFoundCount) AS rejectedJobNotFound',
      );
      expect(queryString).toContain(
        'SUM(entry.rejectedJobNotFoundDiff1) AS rejectedJobNotFoundDiff1',
      );
      expect(queryString).toContain(
        'SUM(entry.rejectedDuplicateShareCount) AS rejectedDuplicatedShare',
      );
      expect(queryString).toContain(
        'SUM(entry.rejectedDuplicateShareDiff1) AS rejectedDuplicatedShareDiff1',
      );
      expect(queryString).toContain(
        'SUM(entry.rejectedLowDifficultyShareCount) AS rejectedLowDifficultyShare',
      );
      expect(queryString).toContain(
        'SUM(entry.rejectedLowDifficultyShareDiff1) AS rejectedLowDifficultyShareDiff1',
      );
      expect(queryString).toContain('LIMIT 432;');

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        label: new Date(1700000000000).toISOString(),
        data: 123.5,
        accepted: 10,
        rejectedJobNotFound: 1,
        rejectedJobNotFoundDiff1: 4000,
        rejectedDuplicatedShare: 2,
        rejectedDuplicatedShareDiff1: 8000,
        rejectedLowDifficultyShare: 3,
        rejectedLowDifficultyShareDiff1: 12000,
      });
    } finally {
      nowSpy.mockRestore();
    }
  });
});
