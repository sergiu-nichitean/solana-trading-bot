import { Filter, FilterResult } from './pool-filters';
import { LiquidityPoolKeysV4, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { Connection } from '@solana/web3.js';
import { logger } from '../helpers';

export class PoolSizeFilter implements Filter {
  constructor(
    private readonly connection: Connection,
    private readonly quoteToken: Token,
    private readonly minPoolSize: TokenAmount,
    private readonly maxPoolSize: TokenAmount,
  ) {}

  async execute(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
    try {
      const response = await this.connection.getTokenAccountBalance(poolKeys.quoteVault, this.connection.commitment);
      const poolSize = new TokenAmount(this.quoteToken, response.value.amount, true);
      let inRange = true;

      if (!this.maxPoolSize?.isZero()) {
        inRange = poolSize.raw.lte(this.maxPoolSize.raw);

        if (!inRange) {
          return { ok: false, type: 'PoolSize', message: `PoolSize -> ${poolSize.toFixed()} > ${this.maxPoolSize.toFixed()}` };
        }
      }

      if (!this.minPoolSize?.isZero()) {
        inRange = poolSize.raw.gte(this.minPoolSize.raw);

        if (!inRange) {
          return { ok: false, type: 'PoolSize', message: `PoolSize -> ${poolSize.toFixed()} < ${this.minPoolSize.toFixed()}` };
        }
      }

      logger.trace({ mint: poolKeys.baseMint.toString() }, `PoolSize: ${poolSize.toFixed()}`);

      return { ok: inRange, type: 'PoolSize', message: `PoolSize -> ${poolSize.toFixed()}` };
    } catch (error) {
      logger.error({ mint: poolKeys.baseMint }, `Failed to check pool size`);
    }

    return { ok: false, type: 'PoolSize', message: 'PoolSize -> -' };
  }
}
