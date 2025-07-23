import { Socket } from 'net';
import { ReplaySubject } from 'rxjs';
jest.mock('./validators/bitcoin-address.validator', () => ({
  IsBitcoinAddress() {
    return jest.fn();
  },
}));

import { StratumV1Client } from './StratumV1Client';
import { eResponseMethod } from './enums/eResponseMethod';
import { eRequestMethod } from './enums/eRequestMethod';
import { PoolRejectedStatisticsService } from '../ORM/pool-rejected-statistics/pool-rejected-statistics.service';
import { ClientRejectedStatisticsService } from '../ORM/client-rejected-statistics/client-rejected-statistics.service';

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
      newMiningJob$: new ReplaySubject<any>(1),
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
      empty,
      empty,
      empty,
      empty
    );
    jest.spyOn<any, any>(client as any, 'getRandomHexString').mockReturnValue('abcd1234');
    jest.spyOn<any, any>(client as any, 'sendNewMiningJob').mockImplementation(async () => {
      await (client as any).write(JSON.stringify({ id: null, method: eResponseMethod.MINING_NOTIFY, params: [] }) + '\n');
    });
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
    await new Promise(r => setTimeout(r, 60));
    const unique = Array.from(new Set((socket.write as jest.Mock).mock.calls.map(c => c[0]))).slice(0,6);
    const msgs = unique.map(m => JSON.parse((m as string).trim()));
    expect(msgs.length).toBe(6);
    expect(msgs[0].id).toBe(1);
    expect(msgs[1].id).toBe(2);
    expect(msgs[2].id).toBe(3);
    expect(msgs[3].method).toBe(eResponseMethod.SET_EXTRANONCE);
    expect(msgs[4].method).toBe(eResponseMethod.SET_DIFFICULTY);
    expect(msgs[5].method).toBe(eResponseMethod.MINING_NOTIFY);
  });

  it('orders messages when extranonce.subscribe precedes authorize', async () => {
    const template = { blockData: { clearJobs: true } } as any;
    (client as any).stratumV1JobsService.newMiningJob$.next(template);

    await send({ id: 1, method: eRequestMethod.SUBSCRIBE, params: ['test'] });
    await send({ id: 2, method: eRequestMethod.EXTRANONCE_SUBSCRIBE });
    await send({ id: 3, method: eRequestMethod.AUTHORIZE, params: ['user', 'x'] });
    await new Promise(r => setTimeout(r, 60));

    const unique = Array.from(new Set((socket.write as jest.Mock).mock.calls.map(c => c[0]))).slice(0,6);
    const msgs = unique.map(m => JSON.parse((m as string).trim()));
    expect(msgs.length).toBe(6);
    expect(msgs[0].id).toBe(1);
    expect(msgs[1].id).toBe(3); // authorize result should follow subscribe
    expect(msgs[2].id).toBe(2); // extranonce.subscribe result
    expect(msgs[3].method).toBe(eResponseMethod.SET_EXTRANONCE);
    expect(msgs[4].method).toBe(eResponseMethod.SET_DIFFICULTY);
    expect(msgs[5].method).toBe(eResponseMethod.MINING_NOTIFY);
  });

  it('handles extranonce.subscribe before subscribe', async () => {
    const template = { blockData: { clearJobs: true } } as any;
    (client as any).stratumV1JobsService.newMiningJob$.next(template);

    await send({ id: 1, method: eRequestMethod.EXTRANONCE_SUBSCRIBE });
    await send({ id: 2, method: eRequestMethod.SUBSCRIBE, params: ['test'] });
    await send({ id: 3, method: eRequestMethod.AUTHORIZE, params: ['user', 'x'] });
    await new Promise(r => setTimeout(r, 60));

    const unique = Array.from(new Set((socket.write as jest.Mock).mock.calls.map(c => c[0]))).slice(0,6);
    const msgs = unique.map(m => JSON.parse((m as string).trim()));
    expect(msgs.length).toBe(6);
    expect(msgs[0].id).toBe(2); // subscribe result
    expect(msgs[1].id).toBe(3); // authorize result
    expect(msgs[2].id).toBe(1); // extranonce.subscribe result
    expect(msgs[3].method).toBe(eResponseMethod.SET_EXTRANONCE);
    expect(msgs[4].method).toBe(eResponseMethod.SET_DIFFICULTY);
    expect(msgs[5].method).toBe(eResponseMethod.MINING_NOTIFY);
  });

  it('orders messages without extranonce.subscribe', async () => {
    const template = { blockData: { clearJobs: true } } as any;
    (client as any).stratumV1JobsService.newMiningJob$.next(template);

    await send({ id: 1, method: eRequestMethod.SUBSCRIBE, params: ['test'] });
    await send({ id: 2, method: eRequestMethod.AUTHORIZE, params: ['user', 'x'] });
    await new Promise(r => setTimeout(r, 60));

    const unique = Array.from(new Set((socket.write as jest.Mock).mock.calls.map(c => c[0]))).slice(0,4);
    const msgs = unique.map(m => JSON.parse((m as string).trim()));
    expect(msgs.length).toBe(4);
    expect(msgs[0].id).toBe(1);
    expect(msgs[1].id).toBe(2);
    expect(msgs[2].method).toBe(eResponseMethod.SET_DIFFICULTY);
    expect(msgs[3].method).toBe(eResponseMethod.MINING_NOTIFY);
  });

  it('handles clients waiting for subscribe reply before authorize', async () => {
    const template = { blockData: { clearJobs: true } } as any;
    (client as any).stratumV1JobsService.newMiningJob$.next(template);

    await send({ id: 1, method: eRequestMethod.SUBSCRIBE, params: ['test'] });
    await new Promise(r => setImmediate(r));

    const firstCall = (socket.write as jest.Mock).mock.calls[0][0];
    const firstMsg = JSON.parse((firstCall as string).trim());
    expect(firstMsg.id).toBe(1);

    await send({ id: 2, method: eRequestMethod.AUTHORIZE, params: ['user', 'x'] });
    await new Promise(r => setTimeout(r, 60));

    const unique = Array.from(new Set((socket.write as jest.Mock).mock.calls.map(c => c[0]))).slice(0,4);
    const msgs = unique.map(m => JSON.parse((m as string).trim()));
    expect(msgs.length).toBe(4);
    expect(msgs[0].id).toBe(1);
    expect(msgs[1].id).toBe(2);
    expect(msgs[2].method).toBe(eResponseMethod.SET_DIFFICULTY);
    expect(msgs[3].method).toBe(eResponseMethod.MINING_NOTIFY);
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
