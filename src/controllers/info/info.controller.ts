import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bitcoinjs from 'bitcoinjs-lib';

@Controller('info')
export class InfoController {
  constructor(private readonly configService: ConfigService) {}

  @Get('sv2-pool-fees')
  getSv2PoolFees() {
    const devFeeAddress = this.configService.get('DEV_FEE_ADDRESS');
    const devFeePercent = parseFloat(this.configService.get('DEV_FEE_PERCENT') ?? '1.5');
    const network = this.configService.get('NETWORK') || 'mainnet';

    // If no pool fee address configured, miners don't need to include pool fees
    if (!devFeeAddress || devFeeAddress.length === 0) {
      return {
        poolFeesRequired: false,
        message: 'No pool fees required for JDP. You can use any coinbase outputs.',
        explanation: {
          status: 'Pool fees are not configured',
          requirement: 'No specific coinbase outputs required',
          validation: 'Any valid coinbase transaction will be accepted',
        },
        usage: {
          allocateMiningJobToken: {
            step: 1,
            description: 'Send AllocateMiningJobToken with your desired coinbase outputs',
            coinbaseTxOutputs: 'Construct any outputs you want (miner rewards, etc.)',
            example: 'Not required - use your own outputs',
          },
          declareMiningJob: {
            step: 2,
            description: 'Send DeclareMiningJob with the same outputs',
            requirement: 'Use the exact same outputs as in step 1',
          },
        },
      };
    }

    // Pool fees are required - provide detailed configuration
    let outputScript: string | null = null;
    try {
      // Convert address to output script for reference
      const script = bitcoinjs.address.toOutputScript(
        devFeeAddress,
        network === 'mainnet'
          ? bitcoinjs.networks.bitcoin
          : network === 'testnet'
          ? bitcoinjs.networks.testnet
          : bitcoinjs.networks.regtest,
      );
      outputScript = script.toString('hex');
    } catch (err) {
      // Invalid address format
      outputScript = null;
    }

    return {
      poolFeesRequired: true,
      message: `Pool fees of ${devFeePercent}% are required. Include the pool payout address in your coinbase outputs.`,
      poolFeeConfiguration: {
        address: devFeeAddress,
        percentage: devFeePercent,
        outputScript: outputScript,
        network: network,
      },
      explanation: {
        status: 'Pool fees are required for all declared jobs',
        requirement: `Your coinbase must include an output paying ${devFeePercent}% to the pool address`,
        validation: 'Both AllocateMiningJobToken and DeclareMiningJob will validate outputs',
        tolerance: '1% tolerance allowed for rounding differences',
      },
      process: {
        overview: 'Two-stage validation ensures miners pay correct pool fees',
        stages: {
          stage1_allocateMiningJobToken: {
            step: 1,
            description: 'Propose your coinbase outputs for validation',
            action: 'Send AllocateMiningJobToken with coinbaseTxOutputs',
            validation: [
              'Pool verifies outputs include pool fee address',
              'Pool verifies fee amount matches configured percentage',
              `Pool verifies fee is approximately ${devFeePercent}% of total coinbase value`,
            ],
            success: 'Receive mining job token if outputs are valid',
            failure: 'Connection closed if outputs are invalid or missing pool fee',
          },
          stage2_declareMiningJob: {
            step: 2,
            description: 'Declare your full mining job using the allocated token',
            action: 'Send DeclareMiningJob with coinbase containing SAME outputs',
            validation: [
              'Pool verifies outputs match what was allocated in stage 1',
              'Pool re-validates pool fee address and amount',
              'Pool ensures outputs were not changed after allocation',
            ],
            success: 'Job approved and bridged to your mining connection',
            failure: 'Job rejected with detailed error message',
          },
        },
      },
      example: {
        description: 'How to construct valid coinbase outputs',
        calculation: {
          blockSubsidy: 625000000,
          transactionFees: 5000000,
          totalCoinbaseValue: 630000000,
          poolFee: Math.floor(630000000 * (devFeePercent / 100)),
          minerAmount: 630000000 - Math.floor(630000000 * (devFeePercent / 100)),
        },
        outputs: [
          {
            index: 0,
            address: devFeeAddress,
            amount: Math.floor(630000000 * (devFeePercent / 100)),
            purpose: 'Pool fee',
            percentage: `${devFeePercent}%`,
          },
          {
            index: 1,
            address: '<your-miner-address>',
            amount: 630000000 - Math.floor(630000000 * (devFeePercent / 100)),
            purpose: 'Miner reward',
            percentage: `${(100 - devFeePercent).toFixed(2)}%`,
          },
        ],
        note: 'You can add additional outputs (e.g., for other payouts), but the pool fee output MUST be present',
      },
      errorMessages: {
        missingPoolFee: `"Missing pool fee output to ${devFeeAddress}"`,
        feeTooLow: `"Pool fee too low: expected ~${Math.floor(630000000 * (devFeePercent / 100))} satoshis (${devFeePercent}%), got X"`,
        outputsMismatch: '"Coinbase outputs do not match allocated outputs"',
      },
      technicalDetails: {
        outputFormat: 'Bitcoin transaction output format: value(8 bytes LE) + script_len(varint) + script',
        validationTolerance: '1% tolerance allowed for rounding differences',
        addressValidation: 'Pool validates using bitcoinjs-lib address decoding',
        caching: 'Outputs are cached with the allocated token for 1 hour',
      },
    };
  }
}
