import { PoolShareStatisticsService } from './pool-share-statistics.service';

describe('PoolShareStatisticsService', () => {
  let mockRepo: any;
  let service: PoolShareStatisticsService;

  beforeEach(() => {
    mockRepo = {
      increment: jest.fn().mockResolvedValue({ affected: 1 }),
      insert: jest.fn().mockResolvedValue(undefined),
      find: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    service = new PoolShareStatisticsService(mockRepo);
  });

  it('uses repo.increment for accepted shares', async () => {
    await service.addAcceptedShare(3);

    expect(mockRepo.increment).toHaveBeenCalledTimes(1);
    expect(mockRepo.increment).toHaveBeenCalledWith(
      { time: expect.any(Number) },
      'accepted',
      3,
    );
    expect(mockRepo.insert).not.toHaveBeenCalled();
  });

  it('uses repo.increment for rejected shares', async () => {
    await service.addRejectedShare(2);

    expect(mockRepo.increment).toHaveBeenCalledWith(
      { time: expect.any(Number) },
      'rejected',
      2,
    );
  });

  it('inserts a fresh row with zeroed sibling column on cold-slot accepted', async () => {
    mockRepo.increment.mockResolvedValueOnce({ affected: 0 });

    await service.addAcceptedShare(5);

    expect(mockRepo.increment).toHaveBeenCalledTimes(1);
    expect(mockRepo.insert).toHaveBeenCalledWith({
      time: expect.any(Number),
      accepted: 5,
      rejected: 0,
    });
  });

  it('inserts a fresh row with zeroed sibling column on cold-slot rejected', async () => {
    mockRepo.increment.mockResolvedValueOnce({ affected: 0 });

    await service.addRejectedShare(7);

    expect(mockRepo.insert).toHaveBeenCalledWith({
      time: expect.any(Number),
      accepted: 0,
      rejected: 7,
    });
  });

  it('retries increment if insert races on the unique-time index', async () => {
    // Mirrors PoolModeHashrateService behavior: a concurrent writer
    // inserted the slot row first, our insert collides on the unique
    // index, fall back to incrementing the existing row.
    mockRepo.increment.mockResolvedValueOnce({ affected: 0 });
    mockRepo.insert.mockRejectedValueOnce(new Error('unique constraint'));
    mockRepo.increment.mockResolvedValueOnce({ affected: 1 });

    await service.addAcceptedShare(4);

    expect(mockRepo.increment).toHaveBeenCalledTimes(2);
    expect(mockRepo.insert).toHaveBeenCalledTimes(1);
  });

  it('discards non-finite share values without touching the database', async () => {
    await service.addAcceptedShare(NaN);
    await service.addAcceptedShare(Infinity);

    expect(mockRepo.increment).not.toHaveBeenCalled();
    expect(mockRepo.insert).not.toHaveBeenCalled();
  });

  it('discards out-of-range share values to protect Postgres `real` column', async () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
    try {
      // Repro: 2026-05-01 buggy SV2 client opened a channel with absurdly
      // small maxTarget and got assigned diff ~9.8e53. Postgres `real`
      // (~3.4e38) would refuse the column, freezing pool-wide stats.
      await service.addRejectedShare(9.8e53);
      await service.addAcceptedShare(9.8e53);

      expect(mockRepo.increment).not.toHaveBeenCalled();
      expect(mockRepo.insert).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('still accepts large but plausible share values below the ceiling', async () => {
    // Network difficulty is ~3.5e14 in 2026 — values up to MAX_REASONABLE_
    // DIFFICULTY (1e15) must continue to flow through unchanged.
    await service.addAcceptedShare(1e14);

    expect(mockRepo.increment).toHaveBeenCalledTimes(1);
    expect(mockRepo.increment).toHaveBeenCalledWith(
      { time: expect.any(Number) },
      'accepted',
      1e14,
    );
  });

  it('swallows DB errors so a failed stats write never blocks share flow', async () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
    try {
      mockRepo.increment.mockRejectedValueOnce(new Error('connection refused'));

      await expect(service.addAcceptedShare(1)).resolves.toBeUndefined();
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
