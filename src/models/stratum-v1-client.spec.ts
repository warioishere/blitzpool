import { Subscription } from 'rxjs';
import * as net from 'net';
import { StratumV1Client } from './StratumV1Client';

// Helper to create a client with mocked dependencies
function createClient(overrides: Record<string, any> = {}) {
  const socket = new net.Socket();
  const dummy = {} as any;
  const clientService = { delete: jest.fn() };
  const configService = {
    get: (key: string) => (key === 'NETWORK' ? 'regtest' : undefined),
  };
  const stratumV1Service = { unregisterClient: jest.fn() };

  const client = new StratumV1Client(
    socket,
    dummy,
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
