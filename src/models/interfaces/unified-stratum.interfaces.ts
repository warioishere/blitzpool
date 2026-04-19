import { Socket } from 'net';

/**
 * Protocol version type for tracking which protocol a client uses.
 */
export type ProtocolVersion = 'v1' | 'v2';

/**
 * Payout mode for a stratum port.
 * - 'solo': Each miner gets their own coinbase (existing behavior)
 * - 'pplns': Shared coinbase with proportional payouts based on PPLNS window
 * - 'group-solo': Per-group shared coinbase, PROP-style (window resets on block)
 */
export type PayoutMode = 'solo' | 'pplns' | 'group-solo';

/**
 * Configuration passed when starting a stratum port.
 */
export interface StratumPortConfig {
  port: number;
  initialDifficulty: number;
  allowSuggestedDifficulty: boolean;
  targetSharesPerMinute: number;
  payoutMode?: PayoutMode;
}

/**
 * Interface for protocol-specific handlers.
 * Both V1 and V2 handlers implement this to receive routed connections
 * from the ProtocolDetectorService.
 */
export interface IProtocolHandler {
  /**
   * Handle a new connection that has been identified as this handler's protocol.
   * @param socket - The raw TCP socket
   * @param firstChunk - The first data received (used for protocol detection)
   * @param portConfig - Configuration for the port the connection arrived on
   */
  handleConnection(
    socket: Socket,
    firstChunk: Buffer,
    portConfig: StratumPortConfig,
  ): void;
}
