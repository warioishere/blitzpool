import { of } from 'rxjs';
import { GeoIpService, GEOIP_CACHE_TTL_MS } from './geoip.service';

describe('GeoIpService cache', () => {
  let service: GeoIpService;
  const httpService = { get: jest.fn() } as any;

  beforeEach(() => {
    jest.useFakeTimers();
    httpService.get.mockReset();
    service = new GeoIpService(httpService);
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
  });

  it('retries lookup after TTL elapses', async () => {
    httpService.get
      .mockReturnValueOnce(of({ data: { status: 'success', city: 'A', country: 'B' } }))
      .mockReturnValueOnce(of({ data: { status: 'success', city: 'C', country: 'D' } }));

    const first = await service.getLocation('1.1.1.1');
    expect(first).toEqual({ city: 'A', country: 'B' });
    expect(httpService.get).toHaveBeenCalledTimes(1);

    const cached = await service.getLocation('1.1.1.1');
    expect(cached).toEqual({ city: 'A', country: 'B' });
    expect(httpService.get).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(GEOIP_CACHE_TTL_MS);

    const afterTtl = await service.getLocation('1.1.1.1');
    expect(afterTtl).toEqual({ city: 'C', country: 'D' });
    expect(httpService.get).toHaveBeenCalledTimes(2);
  });
});
