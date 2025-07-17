import { BehaviorSubject } from 'rxjs';
import { StratumV1JobsService } from './stratum-v1-jobs.service';

class MockBitcoinRpcService {
  public newBlock$ = new BehaviorSubject<any>(null).asObservable();
  public getBlockTemplate() { return Promise.resolve(null); }
}

describe('StratumV1JobsService cleanup', () => {
  beforeEach(() => {
    process.env.JOB_RETENTION_MS = '100';
  });

  it('removes old jobs and blocks', () => {
    const service = new StratumV1JobsService(new MockBitcoinRpcService() as any);
    const old = Date.now() - 200;
    service.jobs['job1'] = { jobId: 'job1', creation: old } as any;
    service.blocks['1'] = {
      block: null as any,
      merkle_branch: [],
      blockData: { id: '1', creation: old, coinbasevalue: 0, networkDifficulty: 0, height: 0, clearJobs: false }
    } as any;
    service.cleanup(false, Date.now());
    expect(service.jobs['job1']).toBeUndefined();
    expect(service.blocks['1']).toBeUndefined();
  });

  it('clears all on new block', () => {
    const service = new StratumV1JobsService(new MockBitcoinRpcService() as any);
    const now = Date.now();
    service.jobs['job1'] = { jobId: 'job1', creation: now } as any;
    service.blocks['1'] = {
      block: null as any,
      merkle_branch: [],
      blockData: { id: '1', creation: now, coinbasevalue: 0, networkDifficulty: 0, height: 0, clearJobs: false }
    } as any;
    service.cleanup(true, Date.now());
    expect(Object.keys(service.jobs).length).toBe(0);
    expect(Object.keys(service.blocks).length).toBe(0);
  });
});

