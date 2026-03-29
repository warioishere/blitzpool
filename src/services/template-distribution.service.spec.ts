import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Subject } from 'rxjs';

import { TemplateDistributionService } from './template-distribution.service';
import { IJobTemplate, StratumV1JobsService } from './stratum-v1-jobs.service';
import { BitcoinRpcService } from './bitcoin-rpc.service';
import { Sv2TdpNewTemplate, Sv2TdpSetNewPrevHash } from '../models/sv2/sv2-tdp-messages';

describe('TemplateDistributionService', () => {
  let service: TemplateDistributionService;
  let jobSubject: Subject<IJobTemplate>;
  let mockBitcoinRpc: Partial<BitcoinRpcService>;

  function createMockJobTemplate(overrides: Partial<IJobTemplate['blockData']> = {}): IJobTemplate {
    const Transaction = require('bitcoinjs-lib').Transaction;
    const coinbaseTx = new Transaction();
    coinbaseTx.version = 2;
    coinbaseTx.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff);
    coinbaseTx.ins[0].witness = [Buffer.alloc(32, 0)];
    coinbaseTx.ins[0].script = Buffer.from('03a08601', 'hex');
    const scriptPubKey = Buffer.from('0014' + 'aa'.repeat(20), 'hex');
    coinbaseTx.addOutput(scriptPubKey, 625000000);

    const Block = require('bitcoinjs-lib').Block;
    const block = new Block();
    block.version = 0x20000000;
    block.prevHash = Buffer.alloc(32, 0xab);
    block.merkleRoot = Buffer.alloc(32, 0xcd);
    block.timestamp = 1700000000;
    block.bits = 0x1d00ffff;
    block.nonce = 0;
    block.transactions = [coinbaseTx];

    return {
      block,
      merkle_branch: [
        'aa'.repeat(32),
        'bb'.repeat(32),
      ],
      blockData: {
        id: '1',
        creation: Date.now(),
        coinbasevalue: 625000000,
        networkDifficulty: 1,
        height: 100000,
        clearJobs: true,
        ...overrides,
      },
    };
  }

  beforeEach(async () => {
    jobSubject = new Subject<IJobTemplate>();
    mockBitcoinRpc = {
      SUBMIT_BLOCK: jest.fn().mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TemplateDistributionService,
        {
          provide: StratumV1JobsService,
          useValue: { newMiningJob$: jobSubject.asObservable() },
        },
        {
          provide: BitcoinRpcService,
          useValue: mockBitcoinRpc,
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue('Public-Pool'),
          },
        },
      ],
    }).compile();

    service = module.get<TemplateDistributionService>(TemplateDistributionService);
    await service.onModuleInit();
  });

  it('converts IJobTemplate to Sv2TdpNewTemplate', (done) => {
    const templates: Sv2TdpNewTemplate[] = [];
    service.newTemplate$.subscribe((t) => {
      templates.push(t);
      if (templates.length === 1) {
        expect(t.templateId).toBe(1n);
        expect(t.futureTemplate).toBe(false);
        expect(t.version).toBe(0x20000000);
        expect(t.coinbaseTxVersion).toBe(2);
        expect(t.coinbaseTxValueRemaining).toBe(625000000n);
        expect(t.merklePath).toHaveLength(2);
        expect(t.merklePath[0]).toEqual(Buffer.from('aa'.repeat(32), 'hex'));
        expect(t.merklePath[1]).toEqual(Buffer.from('bb'.repeat(32), 'hex'));
        done();
      }
    });

    jobSubject.next(createMockJobTemplate());
  });

  it('emits SetNewPrevHash on clearJobs', (done) => {
    service.newPrevHash$.subscribe((ph: Sv2TdpSetNewPrevHash) => {
      expect(ph.templateId).toBe(1n);
      expect(ph.prevHash).toEqual(Buffer.alloc(32, 0xab));
      expect(ph.headerTimestamp).toBe(1700000000);
      expect(ph.nBits).toBe(0x1d00ffff);
      done();
    });

    jobSubject.next(createMockJobTemplate({ clearJobs: true }));
  });

  it('does not emit SetNewPrevHash when clearJobs is false', (done) => {
    let prevHashEmitted = false;
    service.newPrevHash$.subscribe(() => {
      prevHashEmitted = true;
    });

    service.newTemplate$.subscribe(() => {
      // Give a tick for prevHash to potentially emit
      setTimeout(() => {
        expect(prevHashEmitted).toBe(false);
        done();
      }, 50);
    });

    jobSubject.next(createMockJobTemplate({ clearJobs: false }));
  });

  it('marks futureTemplate correctly', (done) => {
    service.newTemplate$.subscribe((t) => {
      expect(t.futureTemplate).toBe(true);
      done();
    });

    jobSubject.next(createMockJobTemplate({ clearJobs: false }));
  });

  it('tracks active templates for lookup', () => {
    jobSubject.next(createMockJobTemplate());
    const stored = service.getTemplate(1n);
    expect(stored).toBeDefined();
    expect(stored!.template.templateId).toBe(1n);
  });

  it('getLatestTemplate returns the most recent template', () => {
    jobSubject.next(createMockJobTemplate());
    jobSubject.next(createMockJobTemplate());
    const latest = service.getLatestTemplate();
    expect(latest).toBeDefined();
    expect(latest!.template.templateId).toBe(2n);
  });

  it('cleans up old templates keeping last 10', () => {
    for (let i = 0; i < 15; i++) {
      jobSubject.next(createMockJobTemplate());
    }
    // Templates 1-5 should be cleaned up, 6-15 should remain
    expect(service.getTemplate(1n)).toBeUndefined();
    expect(service.getTemplate(6n)).toBeDefined();
    expect(service.getTemplate(15n)).toBeDefined();
  });

  it('extracts merkle path from hex strings', (done) => {
    const customBranch = ['cc'.repeat(32), 'dd'.repeat(32), 'ee'.repeat(32)];
    const jt = createMockJobTemplate();
    jt.merkle_branch = customBranch;

    service.newTemplate$.subscribe((t) => {
      expect(t.merklePath).toHaveLength(3);
      expect(t.merklePath[0]).toEqual(Buffer.from('cc'.repeat(32), 'hex'));
      expect(t.merklePath[2]).toEqual(Buffer.from('ee'.repeat(32), 'hex'));
      done();
    });

    jobSubject.next(jt);
  });

  it('stores coinbase structured fields for suffix reconstruction', () => {
    jobSubject.next(createMockJobTemplate());
    const stored = service.getLatestTemplate();
    expect(stored).toBeDefined();

    const tmpl = stored!.template;
    // These fields are needed to reconstruct coinbaseSuffix for extended mining jobs
    expect(tmpl.coinbaseTxInputSequence).toBe(0xffffffff);
    expect(tmpl.coinbaseTxOutputsCount).toBeGreaterThan(0);
    expect(tmpl.coinbaseTxOutputs.length).toBeGreaterThan(0);
    expect(typeof tmpl.coinbaseTxLocktime).toBe('number');

    // Reconstruct suffix: sequence(4) + varint(outputCount) + outputs + locktime(4)
    const sequenceBuf = Buffer.alloc(4);
    sequenceBuf.writeUInt32LE(tmpl.coinbaseTxInputSequence);
    const outputCount = tmpl.coinbaseTxOutputsCount;
    const outputCountBuf = outputCount < 0xfd
      ? Buffer.from([outputCount])
      : Buffer.from([0xfd, outputCount & 0xff, (outputCount >> 8) & 0xff]);
    const locktimeBuf = Buffer.alloc(4);
    locktimeBuf.writeUInt32LE(tmpl.coinbaseTxLocktime);
    const suffix = Buffer.concat([sequenceBuf, outputCountBuf, tmpl.coinbaseTxOutputs, locktimeBuf]);

    // Suffix should be non-empty and contain at least sequence + output count + locktime
    expect(suffix.length).toBeGreaterThanOrEqual(9);
  });

  it('handleSubmitSolution returns template-not-found for unknown template', async () => {
    const result = await service.handleSubmitSolution({
      templateId: 999n,
      version: 0x20000000,
      headerTimestamp: 1700000000,
      headerNonce: 0,
      coinbaseTx: Buffer.alloc(0),
    });
    expect(result).toBe('template-not-found');
  });
});
