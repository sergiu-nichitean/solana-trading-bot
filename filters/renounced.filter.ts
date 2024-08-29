import { Filter, FilterResult } from './pool-filters';
import { MintLayout } from '@solana/spl-token';
import { Connection } from '@solana/web3.js';
import { LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';
import { logger } from '../helpers';

export class RenouncedFreezeFilter implements Filter {
  private readonly errorMessage: string[] = [];

  constructor(
    private readonly connection: Connection,
    private readonly checkRenounced: boolean,
    private readonly checkFreezable: boolean,
  ) {
    if (this.checkRenounced) {
      this.errorMessage.push('mint');
    }

    if (this.checkFreezable) {
      this.errorMessage.push('freeze');
    }
  }

  async execute(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
    try {
      const accountInfo = await this.connection.getAccountInfo(poolKeys.baseMint, this.connection.commitment);
      if (!accountInfo?.data) {
        return { ok: false, type: 'RenouncedFreeze', message: 'MintRenounced: -, Freezable: -' };
      }

      const deserialize = MintLayout.decode(accountInfo.data);
      const renounced = deserialize.mintAuthorityOption === 0;
      const freezable = deserialize.freezeAuthorityOption !== 0;
      const ok = (!this.checkRenounced || renounced) && (!this.checkFreezable || !freezable);
      const message: string[] = [];

      if (!renounced) {
        message.push('mint');
      }

      if (freezable) {
        message.push('freeze');
      }

      return { ok: ok, type: 'RenouncedFreeze', message: `MintRenounced: ${renounced}, Freezable: ${freezable}` };
    } catch (e) {
      logger.error(
        { mint: poolKeys.baseMint },
        `RenouncedFreeze -> Failed to check if creator can ${this.errorMessage.join(' and ')} tokens`,
      );
    }

    return {
      ok: false,
      type: 'RenouncedFreeze',
      message: `RenouncedFreeze -> Failed to check if creator can ${this.errorMessage.join(' and ')} tokens`,
    };
  }
}
