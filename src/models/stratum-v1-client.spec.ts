import { Subscription } from 'rxjs';
import * as net from 'net';
import { StratumV1Client } from './StratumV1Client';

interface CreateClientOptions {
  overrides?: Record<string, any>;
  initialDifficulty?: number;
  configValues?: Record<string, string>;
}

// Helper to create a client with mocked dependencies
function createClient(options: CreateClientOptions = {}) {
  const {
    overrides = {},
    initialDifficulty = 16384,
    configValues = {},
  } = options;
  const socket = new net.Socket();
  const dummy = {} as any;
  const stratumV1JobsService = {
    newMiningJob$: {
      subscribe: jest.fn().mockReturnValue({ unsubscribe: jest.fn() }),
    },
    getNextId: jest.fn(),
    addJob: jest.fn(),
    jobs: {},
  };
  const clientService = { delete: jest.fn() };
  const configService = {
    get: (key: string) => {
      if (key in configValues) {
        return configValues[key];
      }
      if (key === 'NETWORK') {
        return configValues.NETWORK ?? 'regtest';
      }
      return undefined;
    },
  };
  const stratumV1Service = { unregisterClient: jest.fn() };

  const client = new StratumV1Client(
    socket,
    stratumV1JobsService as any,
    dummy,
    clientService as any,
    dummy,
    dummy,
    dummy,
    configService as any,
    dummy,
    dummy,
    dummy,
    dummy,
    dummy,
    dummy,
    stratumV1Service as any,
    initialDifficulty,
  );

  Object.assign(client as any, overrides);
  return { client, socket, stratumV1Service };
}

describe('StratumV1Client.destroy', () => {
  it('handles destroy before authorization and subscription', async () => {
    const { client, socket, stratumV1Service } = createClient();
    await expect(client.destroy()).resolves.not.toThrow();
    expect(stratumV1Service.unregisterClient).not.toHaveBeenCalled();
    socket.destroy();
  });

  it('handles destroy with subscription but without authorization', async () => {
    let unsubscribed = false;
    const { client, socket, stratumV1Service } = createClient({
      stratumSubscription: new Subscription(() => {
        unsubscribed = true;
      }),
    });
    await expect(client.destroy()).resolves.not.toThrow();
    expect(unsubscribed).toBe(true);
    expect(stratumV1Service.unregisterClient).not.toHaveBeenCalled();
    socket.destroy();
  });

  it('handles destroy with authorization but without subscription', async () => {
    const { client, socket, stratumV1Service } = createClient({
      clientAuthorization: { address: 'abc' },
    });
    await expect(client.destroy()).resolves.not.toThrow();
    expect(stratumV1Service.unregisterClient).toHaveBeenCalledWith('abc', client);
    socket.destroy();
  });
});

describe('StratumV1Client cpuminer fallback', () => {
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('applies the cpuminer fallback on the standard listener', async () => {
    jest.useFakeTimers();
    const write = jest.fn().mockResolvedValue(true);
    const { client, socket } = createClient({
      overrides: {
        clientSubscription: { userAgent: 'cpuminer' },
        write,
      },
      configValues: {
        STRATUM_HIGH_DIFF_START_DIFFICULTY: '100000',
      },
    });

    await (client as any).initStratum();

    expect(write).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(write.mock.calls[0][0]);
    expect(payload.params[0]).toBe(0.1);
    expect((client as any).sessionDifficulty).toBe(0.1);
    socket.destroy();
  });

  it('keeps the high-difficulty handshake when starting at 100000', async () => {
    jest.useFakeTimers();
    const write = jest.fn().mockResolvedValue(true);
    const { client, socket } = createClient({
      overrides: {
        clientSubscription: { userAgent: 'cpuminer' },
        write,
      },
      initialDifficulty: 100000,
      configValues: {
        STRATUM_HIGH_DIFF_START_DIFFICULTY: '100000',
      },
    });

    await (client as any).initStratum();

    expect(write).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(write.mock.calls[0][0]);
    expect(payload.params[0]).toBe(100000);
    expect((client as any).sessionDifficulty).toBe(100000);
    socket.destroy();
  });
});
