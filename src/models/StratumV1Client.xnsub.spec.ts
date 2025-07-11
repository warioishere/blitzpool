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

  it('responds with set_extranonce when extranonce.subscribe is received', async () => {
    await send({ id: 1, method: eRequestMethod.SUBSCRIBE, params: ['test'] });
    const sid = client.extraNonceAndSessionId;
    await send({ id: 2, method: eRequestMethod.EXTRANONCE_SUBSCRIBE });

    expect(socket.write).toHaveBeenNthCalledWith(2,
      JSON.stringify({ id: 2, error: null, result: true }) + '\n', expect.any(Function));
    expect(socket.write).toHaveBeenNthCalledWith(3,
      JSON.stringify({ id: null, method: eResponseMethod.SET_EXTRANONCE, params: [sid, 4] }) + '\n', expect.any(Function));
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
