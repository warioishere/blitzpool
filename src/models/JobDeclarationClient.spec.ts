// JobDeclarationClient — end-to-end state-machine tests.
//
// These exercise the post-handshake dispatch path: SetupConnection →
// RequestExtensions → AllocateMiningJobToken → RequestCoinbaseOutputs,
// observing the exact bytes that go out on the wire. We mock the Socket
// and the Noise session (since real Noise needs valid keys + remote
// Act1 from libsecp256k1) but use the REAL frame writer, REAL message
// (de)serializers, and REAL handleFrame dispatcher.

import { Socket } from 'net';
import { JobDeclarationClient, JobDeclarationServiceRef, Sv2PoolPayout } from './JobDeclarationClient';
import {
  Sv2MsgType,
  SV2_EXTENSION_TYPE_NEGOTIATION,
  SV2_EXTENSION_TYPE_DYNAMIC_COINBASE_OUTPUTS,
} from './sv2/sv2-constants';
import {
  serializeAllocateMiningJobToken,
} from './sv2/sv2-jdp-messages';
import { BufferWriter, BufferReader } from './sv2/sv2-binary-codec';
import {
  serializeRequestCoinbaseOutputs,
  deserializeRequestCoinbaseOutputsSuccess,
  deserializeRequestCoinbaseOutputsError,
} from './sv2/sv2-extensions-messages';

// We don't run Noise here — we set encryption to identity (no-op) and
// inject our own SetupConnection state via the test helper below.
//
// Each call to fakeNoiseSession.encrypt returns the plaintext unchanged,
// and each Sv2FrameWriter is wired with that identity-encryptor so the
// outgoing buffer captured by `socketWrites` is the plaintext frame.

function noopEncrypt(plain: Buffer): Buffer {
  return Buffer.from(plain);
}

/**
 * Build a JobDeclarationClient in a state where SetupConnection.Success
 * has already been exchanged. This bypasses the Noise handshake (which
 * needs a real EllSwift keypair + Act1) so we can focus on the
 * post-setup state machine.
 *
 * Returns a tuple of [client, socketWrites] where socketWrites is the
 * array of plaintext frame buffers the client has emitted so far.
 */
function makeReadyClient(serviceOverrides: Partial<JobDeclarationServiceRef> = {}) {
  const socketWrites: Buffer[] = [];

  // Minimal socket fake: capture writes, ignore everything else.
  const fakeSocketBag = {
    destroyed: false,
    writableEnded: false,
  };
  const fakeSocket = {
    remoteAddress: '203.0.113.42',
    get destroyed() { return fakeSocketBag.destroyed; },
    get writableEnded() { return fakeSocketBag.writableEnded; },
    setTimeout: () => {},
    setNoDelay: () => {},
    on: () => fakeSocket,
    once: () => fakeSocket,
    removeListener: () => fakeSocket,
    write: (data: Buffer, cb?: (err?: Error) => void) => {
      socketWrites.push(Buffer.from(data));
      if (cb) cb();
      return true;
    },
    destroy: () => { fakeSocketBag.destroyed = true; },
  } as unknown as Socket;

  const service: JobDeclarationServiceRef = {
    getNoiseConfig: () => ({
      // Doesn't matter — we stub out handshake entirely below.
      staticKeypair: { privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(64) },
      certificateMessage: {
        version: 0,
        validFrom: 0,
        notValidAfter: 0,
        signature: Buffer.alloc(64),
      },
    }),
    validateTransactions: jest.fn().mockResolvedValue({ known: [], unknown: [] }),
    onJobDeclared: jest.fn(),
    getConfigValue: () => undefined,
    getMinerAddressByIp: () => null,
    getMinerInfoByIp: () => null,
    getBlockHeight: () => 0,
    resolveCoinbasePayout: jest.fn().mockResolvedValue({
      addresses: ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'],
      weights: null,
    } satisfies Sv2PoolPayout),
    encodeCoinbaseOutputs: jest.fn().mockReturnValue(Buffer.from([0x01, 0, 0, 0, 0, 0, 0, 0, 0, 22])), // 1 dummy output
    handleRequestCoinbaseOutputs: jest.fn(),
    findEmittedOutputsForJob: jest.fn().mockReturnValue(null),
    getTemplateTransactions: () => new Map(),
    getCurrentPrevHash: () => null,
    getRawTransaction: jest.fn().mockResolvedValue(null),
    submitBlock: jest.fn().mockResolvedValue('SUCCESS!'),
    saveBlock: jest.fn().mockResolvedValue(undefined),
    notifyBlockFound: jest.fn().mockResolvedValue(undefined),
    ...serviceOverrides,
  };

  // Construct, then stub out the handshake side-effects. We pass an
  // empty firstChunk — the handshake path errors and gets swallowed by
  // the .catch in the constructor.
  const client = new JobDeclarationClient(fakeSocket, Buffer.alloc(0), service);

  // The constructor kicked off an async handshake that will reject
  // (empty firstChunk) and call destroySocket(). Wait one tick to let
  // that catch fire, then reset the destruction state so writes work.
  return {
    client,
    service,
    socketWrites,
    /**
     * Must be awaited before exercising the state machine — undoes
     * the side-effects of the failed-handshake catch and primes the
     * client into a "post-SetupConnection.Success" state.
     */
    ready: async () => {
      await Promise.resolve(); // let constructor's .catch run
      await Promise.resolve();
      fakeSocketBag.destroyed = false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c: any = client;
      c.destroyed = false;
      c.setupComplete = true;
      c.fullTemplateMode = true;
      c.frameWriter.setEncryptFn(noopEncrypt);
      // Reset socketWrites — any noise during the failed handshake doesn't count.
      socketWrites.length = 0;
    },
  };
}

/**
 * Parse a captured frame buffer back into (extensionType, msgType, payload).
 * The frame format is: ext_type U16 LE | msg_type U8 | msg_length U24 LE | payload.
 */
function parseFrame(buf: Buffer): { extensionType: number; msgType: number; payload: Buffer } {
  const extensionType = buf.readUInt16LE(0);
  const msgType = buf.readUInt8(2);
  const msgLength = buf[3] | (buf[4] << 8) | (buf[5] << 16);
  return {
    extensionType,
    msgType,
    payload: buf.subarray(6, 6 + msgLength),
  };
}

describe('JobDeclarationClient — extensions negotiation (ext 0x0001)', () => {
  test('RequestExtensions[0x0003] when supported → Success with [0x0003] and ext_type=0x0001 frame', async () => {
    const { client, socketWrites, ready } = makeReadyClient();
    await ready();

    // Build a RequestExtensions payload requesting just 0x0003.
    const reqPayload = (() => {
      const w = new BufferWriter();
      w.writeU16(0xCAFE);              // request_id
      w.writeU16(1);                    // SEQ count
      w.writeU16(SV2_EXTENSION_TYPE_DYNAMIC_COINBASE_OUTPUTS);
      return w.toBuffer();
    })();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).handleFrame(SV2_EXTENSION_TYPE_NEGOTIATION, Sv2MsgType.EXT_REQUEST_EXTENSIONS, reqPayload);

    expect(socketWrites).toHaveLength(1);
    const frame = parseFrame(socketWrites[0]);

    // Frame header carries ext_type = 0x0001 per spec ext 0x0001 §3.
    expect(frame.extensionType).toBe(SV2_EXTENSION_TYPE_NEGOTIATION);
    expect(frame.msgType).toBe(Sv2MsgType.EXT_REQUEST_EXTENSIONS_SUCCESS);

    // Parse the .Success payload and confirm 0x0003 is in supported list.
    const reader = new BufferReader(frame.payload);
    const requestId = reader.readU16();
    const count = reader.readU16();
    expect(requestId).toBe(0xCAFE);
    expect(count).toBe(1);
    expect(reader.readU16()).toBe(SV2_EXTENSION_TYPE_DYNAMIC_COINBASE_OUTPUTS);

    // Client's internal negotiation state was updated.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).negotiatedExtensions.has(SV2_EXTENSION_TYPE_DYNAMIC_COINBASE_OUTPUTS)).toBe(true);
  });

  test('RequestExtensions[unknown-ext] → .Error listing it as unsupported (spec §4.1)', async () => {
    const { client, socketWrites, ready } = makeReadyClient();
    await ready();

    const reqPayload = (() => {
      const w = new BufferWriter();
      w.writeU16(1);
      w.writeU16(1);
      w.writeU16(0xBEEF);
      return w.toBuffer();
    })();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).handleFrame(SV2_EXTENSION_TYPE_NEGOTIATION, Sv2MsgType.EXT_REQUEST_EXTENSIONS, reqPayload);

    const frame = parseFrame(socketWrites[0]);
    expect(frame.extensionType).toBe(SV2_EXTENSION_TYPE_NEGOTIATION);
    expect(frame.msgType).toBe(Sv2MsgType.EXT_REQUEST_EXTENSIONS_ERROR);

    const reader = new BufferReader(frame.payload);
    const requestId = reader.readU16();
    expect(requestId).toBe(1);
    const unsupportedCount = reader.readU16();
    expect(unsupportedCount).toBe(1);
    expect(reader.readU16()).toBe(0xBEEF);
    // requiredExtensions list — empty (we don't require anything).
    expect(reader.readU16()).toBe(0);
  });

  test('RequestExtensions with mix → .Success with only the supported subset', async () => {
    const { client, socketWrites, ready } = makeReadyClient();
    await ready();

    const reqPayload = (() => {
      const w = new BufferWriter();
      w.writeU16(7);
      w.writeU16(3);
      w.writeU16(0x9999);                              // unknown
      w.writeU16(SV2_EXTENSION_TYPE_DYNAMIC_COINBASE_OUTPUTS);
      w.writeU16(0xAAAA);                              // unknown
      return w.toBuffer();
    })();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).handleFrame(SV2_EXTENSION_TYPE_NEGOTIATION, Sv2MsgType.EXT_REQUEST_EXTENSIONS, reqPayload);

    const frame = parseFrame(socketWrites[0]);
    expect(frame.msgType).toBe(Sv2MsgType.EXT_REQUEST_EXTENSIONS_SUCCESS);

    const reader = new BufferReader(frame.payload);
    expect(reader.readU16()).toBe(7); // requestId
    expect(reader.readU16()).toBe(1); // 1 supported
    expect(reader.readU16()).toBe(SV2_EXTENSION_TYPE_DYNAMIC_COINBASE_OUTPUTS);
  });

  test('RequestExtensions before SetupConnection → ignored, no response', async () => {
    const { client, socketWrites, ready } = makeReadyClient();
    await ready();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).setupComplete = false;

    const reqPayload = (() => {
      const w = new BufferWriter();
      w.writeU16(3);
      w.writeU16(1);
      w.writeU16(SV2_EXTENSION_TYPE_DYNAMIC_COINBASE_OUTPUTS);
      return w.toBuffer();
    })();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).handleFrame(SV2_EXTENSION_TYPE_NEGOTIATION, Sv2MsgType.EXT_REQUEST_EXTENSIONS, reqPayload);

    expect(socketWrites).toHaveLength(0);
  });
});

describe('JobDeclarationClient — AllocateMiningJobToken.Success payload shape', () => {
  test('without ext 0x0003: Success carries the §6.4.3 single-output payload, nothing else', async () => {
    const { client, socketWrites, service, ready } = makeReadyClient();
    await ready();

    // No RequestExtensions sent → no extensions negotiated.

    const allocPayload = serializeAllocateMiningJobToken({
      userIdentifier: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
      requestId: 1,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).handleFrame(0, Sv2MsgType.JDP_ALLOCATE_MINING_JOB_TOKEN, allocPayload);

    expect(socketWrites).toHaveLength(1);
    const frame = parseFrame(socketWrites[0]);
    expect(frame.msgType).toBe(Sv2MsgType.JDP_ALLOCATE_MINING_JOB_TOKEN_SUCCESS);

    // request_id U32 + mining_job_token B0_255 + coinbase_outputs B0_64K
    // — and nothing else. The static-weights TLV is gone.
    const reader = new BufferReader(frame.payload);
    reader.readU32();
    reader.readB0_255();
    reader.readB0_64K();
    expect(reader.remaining).toBe(0);

    const callArgs = (service.resolveCoinbasePayout as jest.Mock).mock.calls[0];
    expect(callArgs[1].size).toBe(0);
  });

  test('with ext 0x0003 negotiated: Success STILL carries no TLV (§3.4 fallback path only)', async () => {
    // Ext 0x0003 moved the dynamic distribution to RequestCoinbaseOutputs;
    // AllocateMiningJobToken.Success now only carries the §6.4.3 fallback
    // outputs regardless of negotiation, and nothing trailing.
    const { client, socketWrites, ready } = makeReadyClient();
    await ready();

    // Negotiate.
    const reqPayload = (() => {
      const w = new BufferWriter();
      w.writeU16(1);
      w.writeU16(1);
      w.writeU16(SV2_EXTENSION_TYPE_DYNAMIC_COINBASE_OUTPUTS);
      return w.toBuffer();
    })();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).handleFrame(SV2_EXTENSION_TYPE_NEGOTIATION, Sv2MsgType.EXT_REQUEST_EXTENSIONS, reqPayload);
    expect(socketWrites).toHaveLength(1);

    const allocPayload = serializeAllocateMiningJobToken({
      userIdentifier: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
      requestId: 1,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).handleFrame(0, Sv2MsgType.JDP_ALLOCATE_MINING_JOB_TOKEN, allocPayload);

    const frame = parseFrame(socketWrites[1]);
    const reader = new BufferReader(frame.payload);
    reader.readU32();
    reader.readB0_255();
    reader.readB0_64K();
    expect(reader.remaining).toBe(0);
  });
});

describe('JobDeclarationClient — RequestCoinbaseOutputs (ext 0x0003)', () => {
  /** Helper: negotiate 0x0003, allocate a token, return the token bytes. */
  async function negotiateAndAllocate(
    client: JobDeclarationClient,
    socketWrites: Buffer[],
    minerAddress = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
  ): Promise<Buffer> {
    const reqPayload = (() => {
      const w = new BufferWriter();
      w.writeU16(1);
      w.writeU16(1);
      w.writeU16(SV2_EXTENSION_TYPE_DYNAMIC_COINBASE_OUTPUTS);
      return w.toBuffer();
    })();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).handleFrame(SV2_EXTENSION_TYPE_NEGOTIATION, Sv2MsgType.EXT_REQUEST_EXTENSIONS, reqPayload);

    const allocPayload = serializeAllocateMiningJobToken({
      userIdentifier: minerAddress,
      requestId: 1,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).handleFrame(0, Sv2MsgType.JDP_ALLOCATE_MINING_JOB_TOKEN, allocPayload);

    // Extract the issued token from the AllocateMiningJobToken.Success frame.
    const allocSuccessFrame = parseFrame(socketWrites[socketWrites.length - 1]);
    const r = new BufferReader(allocSuccessFrame.payload);
    r.readU32();
    return r.readB0_255();
  }

  test('happy path: Request → Success frame with outputs from service', async () => {
    const stubOutputs = Buffer.from('01' + '0000000000000000' + '02' + '0123', 'hex');
    const { client, socketWrites, service, ready } = makeReadyClient({
      handleRequestCoinbaseOutputs: jest.fn().mockResolvedValue({
        kind: 'success',
        success: { requestId: 7, coinbaseTxOutputs: stubOutputs },
      }),
    });
    await ready();

    const token = await negotiateAndAllocate(client, socketWrites);
    socketWrites.length = 0;

    const prevHash = Buffer.alloc(32, 0x11);
    const reqPayload = serializeRequestCoinbaseOutputs({
      requestId: 7,
      miningJobToken: token,
      prevHash,
      poolRevenue: 312_500_000n,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).handleFrame(
      SV2_EXTENSION_TYPE_DYNAMIC_COINBASE_OUTPUTS,
      Sv2MsgType.EXT_REQUEST_COINBASE_OUTPUTS,
      reqPayload,
    );

    expect(socketWrites).toHaveLength(1);
    const frame = parseFrame(socketWrites[0]);
    expect(frame.extensionType).toBe(SV2_EXTENSION_TYPE_DYNAMIC_COINBASE_OUTPUTS);
    expect(frame.msgType).toBe(Sv2MsgType.EXT_REQUEST_COINBASE_OUTPUTS_SUCCESS);

    const parsed = deserializeRequestCoinbaseOutputsSuccess(new BufferReader(frame.payload));
    expect(parsed.requestId).toBe(7);
    expect(parsed.coinbaseTxOutputs).toEqual(stubOutputs);

    // Service was called with the correct miner address (bound at allocation).
    const callArgs = (service.handleRequestCoinbaseOutputs as jest.Mock).mock.calls[0];
    expect(callArgs[1]).toBe('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
  });

  test('unknown token → invalid-mining-job-token error frame (without calling service)', async () => {
    const handler = jest.fn();
    const { client, socketWrites, ready } = makeReadyClient({
      handleRequestCoinbaseOutputs: handler,
    });
    await ready();

    // Negotiate but DON'T allocate — the request will reference a bogus token.
    const reqExtPayload = (() => {
      const w = new BufferWriter();
      w.writeU16(1);
      w.writeU16(1);
      w.writeU16(SV2_EXTENSION_TYPE_DYNAMIC_COINBASE_OUTPUTS);
      return w.toBuffer();
    })();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).handleFrame(SV2_EXTENSION_TYPE_NEGOTIATION, Sv2MsgType.EXT_REQUEST_EXTENSIONS, reqExtPayload);
    socketWrites.length = 0;

    const reqPayload = serializeRequestCoinbaseOutputs({
      requestId: 42,
      miningJobToken: Buffer.from('deadbeef', 'hex'),
      prevHash: Buffer.alloc(32),
      poolRevenue: 100n,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).handleFrame(
      SV2_EXTENSION_TYPE_DYNAMIC_COINBASE_OUTPUTS,
      Sv2MsgType.EXT_REQUEST_COINBASE_OUTPUTS,
      reqPayload,
    );

    expect(handler).not.toHaveBeenCalled();
    expect(socketWrites).toHaveLength(1);
    const frame = parseFrame(socketWrites[0]);
    expect(frame.msgType).toBe(Sv2MsgType.EXT_REQUEST_COINBASE_OUTPUTS_ERROR);

    const parsed = deserializeRequestCoinbaseOutputsError(new BufferReader(frame.payload));
    expect(parsed.requestId).toBe(42);
    expect(parsed.errorCode).toBe('invalid-mining-job-token');
  });

  test('service returns error → propagated to wire as Error frame', async () => {
    const { client, socketWrites, ready } = makeReadyClient({
      handleRequestCoinbaseOutputs: jest.fn().mockResolvedValue({
        kind: 'error',
        error: { requestId: 9, errorCode: 'stale-prev-hash' },
      }),
    });
    await ready();

    const token = await negotiateAndAllocate(client, socketWrites);
    socketWrites.length = 0;

    const reqPayload = serializeRequestCoinbaseOutputs({
      requestId: 9,
      miningJobToken: token,
      prevHash: Buffer.alloc(32, 0xAA),
      poolRevenue: 312_500_000n,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).handleFrame(
      SV2_EXTENSION_TYPE_DYNAMIC_COINBASE_OUTPUTS,
      Sv2MsgType.EXT_REQUEST_COINBASE_OUTPUTS,
      reqPayload,
    );

    const frame = parseFrame(socketWrites[0]);
    expect(frame.extensionType).toBe(SV2_EXTENSION_TYPE_DYNAMIC_COINBASE_OUTPUTS);
    expect(frame.msgType).toBe(Sv2MsgType.EXT_REQUEST_COINBASE_OUTPUTS_ERROR);

    const parsed = deserializeRequestCoinbaseOutputsError(new BufferReader(frame.payload));
    expect(parsed.errorCode).toBe('stale-prev-hash');
  });

  test('frame arrives before 0x0003 was negotiated → silently dropped (no response)', async () => {
    const handler = jest.fn();
    const { client, socketWrites, ready } = makeReadyClient({
      handleRequestCoinbaseOutputs: handler,
    });
    await ready();

    const reqPayload = serializeRequestCoinbaseOutputs({
      requestId: 1,
      miningJobToken: Buffer.from('00', 'hex'),
      prevHash: Buffer.alloc(32),
      poolRevenue: 0n,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).handleFrame(
      SV2_EXTENSION_TYPE_DYNAMIC_COINBASE_OUTPUTS,
      Sv2MsgType.EXT_REQUEST_COINBASE_OUTPUTS,
      reqPayload,
    );

    expect(handler).not.toHaveBeenCalled();
    expect(socketWrites).toHaveLength(0);
  });
});
