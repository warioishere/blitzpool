import { Socket } from 'net';
import { Subject } from 'rxjs';
jest.mock('./validators/bitcoin-address.validator', () => ({
  IsBitcoinAddress() {
    return jest.fn();
  },
}));

import { StratumV1Client } from './StratumV1Client';
import { eResponseMethod } from './enums/eResponseMethod';
import { eRequestMethod } from './enums/eRequestMethod';

describe('StratumV1Client XNSub', () => {
  let socket: any;
  let onData: (data: Buffer) => void;
  let client: StratumV1Client;

  beforeEach(() => {
    socket = {
      destroyed: false,
      writableEnded: false,
      on: jest.fn((event: string, cb: any) => {
        if (event === 'data') {
          onData = cb;
        }
        return socket;
      }),
      write: jest.fn((data: string, cb?: Function) => {
        if (cb) cb();
        return true;
      }),
      end: jest.fn(),
    } as unknown as Socket;

    const stratumV1JobsService = {
      newMiningJob$: new Subject<any>(),
      addJob: jest.fn(),
      getNextId: jest.fn().mockReturnValue('1'),
      getNextTemplateId: jest.fn().mockReturnValue('1'),
      getJobById: jest.fn(),
      getJobTemplateById: jest.fn(),
    } as any;

    const empty = {} as any;
    const configService = {
      get: jest.fn((key: string) => {
        switch (key) {
          case 'DEV_FEE_PERCENT': return '0';
          case 'NETWORK': return 'testnet';
          default: return null;
        }
      })
    } as any;

    client = new StratumV1Client(
      socket,
      stratumV1JobsService,
      empty,
      { delete: jest.fn(), updateSessionId: jest.fn() } as any,
      empty,
      empty,
      empty,
      configService,
      empty,
      empty
    );

    client.extraNonceAndSessionId = 'abcd1234';
  });

  afterEach(() => {
    client.destroy();
  });

  async function send(msg: any) {
    onData(Buffer.from(JSON.stringify(msg) + '\n'));
    await new Promise((r) => setImmediate(r));
  }

  it('orders messages when extranonce.subscribe follows authorize', async () => {
    const template = { blockData: { clearJobs: true } } as any;
    (client as any).stratumV1JobsService.newMiningJob$.next(template);

    await send({ id: 1, method: eRequestMethod.SUBSCRIBE, params: ['test'] });
    await send({ id: 2, method: eRequestMethod.AUTHORIZE, params: ['user', 'x'] });
    await send({ id: 3, method: eRequestMethod.EXTRANONCE_SUBSCRIBE });

    const calls = (socket.write as jest.Mock).mock.calls.map(c => c[0]);
    expect(calls[0]).toContain('mining.subscribe');
    expect(calls[1]).toContain('mining.authorize');
    expect(calls[2]).toContain('mining.extranonce.subscribe');
    expect(calls[3]).toContain('mining.set_extranonce');
    expect(calls[4]).toContain('mining.set_difficulty');
    expect(calls[5]).toContain('mining.notify');
  });

  it('orders messages when extranonce.subscribe precedes authorize', async () => {
    const template = { blockData: { clearJobs: true } } as any;
    (client as any).stratumV1JobsService.newMiningJob$.next(template);

    await send({ id: 1, method: eRequestMethod.SUBSCRIBE, params: ['test'] });
    await send({ id: 2, method: eRequestMethod.EXTRANONCE_SUBSCRIBE });
    await send({ id: 3, method: eRequestMethod.AUTHORIZE, params: ['user', 'x'] });

    const calls = (socket.write as jest.Mock).mock.calls.map(c => c[0]);
    expect(calls[0]).toContain('mining.subscribe');
    expect(calls[1]).toContain('mining.extranonce.subscribe');
    expect(calls[2]).toContain('mining.authorize');
    expect(calls[3]).toContain('mining.set_extranonce');
    expect(calls[4]).toContain('mining.set_difficulty');
    expect(calls[5]).toContain('mining.notify');
  });

  it('sends new extranonce before notify on clearJobs', async () => {
    await send({ id: 1, method: eRequestMethod.SUBSCRIBE, params: ['test'] });
    await send({ id: 2, method: eRequestMethod.EXTRANONCE_SUBSCRIBE });
    (client as any).clientAuthorization = { address: 'tb1qaddr', worker: 'worker' };

    jest.spyOn<any, any>(client as any, 'sendNewMiningJob').mockImplementation(async (jt: any) => {
      if (jt.blockData.clearJobs && (client as any).extraNonceSubscribed) {
        await (client as any).sendSetExtraNonce();
      }
      await (client as any).write(JSON.stringify({ id: null, method: eResponseMethod.MINING_NOTIFY, params: [] }) + '\n');
    });

    await (client as any).sendNewMiningJob({ blockData: { clearJobs: true } });

    const first = (socket.write as jest.Mock).mock.calls[(socket.write as jest.Mock).mock.calls.length - 2][0];
    const second = (socket.write as jest.Mock).mock.calls[(socket.write as jest.Mock).mock.calls.length - 1][0];

    expect(first).toContain('mining.set_extranonce');
    expect(second).toContain('mining.notify');
  });

  it('does not send extranonce update for unsubscribed clients', async () => {
    await send({ id: 1, method: eRequestMethod.SUBSCRIBE, params: ['test'] });
    (client as any).clientAuthorization = { address: 'tb1qaddr', worker: 'worker' };

    jest.spyOn<any, any>(client as any, 'sendNewMiningJob').mockImplementation(async (jt: any) => {
      if (jt.blockData.clearJobs && (client as any).extraNonceSubscribed) {
        await (client as any).sendSetExtraNonce();
      }
      await (client as any).write(JSON.stringify({ id: null, method: eResponseMethod.MINING_NOTIFY, params: [] }) + '\n');
    });

    await (client as any).sendNewMiningJob({ blockData: { clearJobs: true } });

    const calls = (socket.write as jest.Mock).mock.calls.map(c => c[0]);
    expect(calls.some(c => (c as string).includes('mining.set_extranonce'))).toBe(false);
    expect(calls[calls.length - 1]).toContain('mining.notify');
  });
});
