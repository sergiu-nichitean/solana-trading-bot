import { Connection } from '@solana/web3.js';
import { LiquidityPoolKeysV4, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { getMetadataAccountDataSerializer } from '@metaplex-foundation/mpl-token-metadata';
import { BurnFilter } from './burn.filter';
import { MutableFilter } from './mutable.filter';
import { RenouncedFreezeFilter } from './renounced.filter';
import { PoolSizeFilter } from './pool-size.filter';
import { CHECK_IF_BURNED, CHECK_IF_FREEZABLE, CHECK_IF_MINT_IS_RENOUNCED, CHECK_IF_MUTABLE, CHECK_IF_SOCIALS, logger } from '../helpers';

export interface Filter {
  execute(poolKeysV4: LiquidityPoolKeysV4): Promise<FilterResult>;
}

export interface FilterResult {
  ok: boolean;
  type: string;
  message?: string;
}

export interface PoolFilterArgs {
  minPoolSize: TokenAmount;
  maxPoolSize: TokenAmount;
  quoteToken: Token;
}

interface ExecuteResult {
  outcome: boolean,
  allResults: FilterResult[]
}

export class PoolFilters {
  private readonly allFilters: Filter[] = [];
  private readonly checkedFilters: string[] = [];

  constructor(
    readonly connection: Connection,
    readonly args: PoolFilterArgs,
  ) {
    const burnFilter = new BurnFilter(connection);
    const renouncedFreezeFilter = new RenouncedFreezeFilter(connection, CHECK_IF_MINT_IS_RENOUNCED, CHECK_IF_FREEZABLE);
    const mutableFilter = new MutableFilter(connection, getMetadataAccountDataSerializer(), CHECK_IF_MUTABLE, CHECK_IF_SOCIALS);
    const poolSizeFilter = new PoolSizeFilter(connection, args.quoteToken, args.minPoolSize, args.maxPoolSize);

    this.allFilters.push(burnFilter);
    this.allFilters.push(renouncedFreezeFilter);
    this.allFilters.push(mutableFilter);
    this.allFilters.push(poolSizeFilter);

    if (CHECK_IF_BURNED) {
      this.checkedFilters.push('Burn');
    }

    if (CHECK_IF_MINT_IS_RENOUNCED || CHECK_IF_FREEZABLE) {
      this.checkedFilters.push('RenouncedFreeze');
    }

    if (CHECK_IF_MUTABLE || CHECK_IF_SOCIALS) {
      this.checkedFilters.push('MutableSocials');
    }

    if (!args.minPoolSize.isZero() || !args.maxPoolSize.isZero()) {
      this.checkedFilters.push('PoolSize');
    }
  }

  public async execute(poolKeys: LiquidityPoolKeysV4): Promise<ExecuteResult> {
    let outcome: boolean = false;

    if (this.checkedFilters.length === 0) {
      outcome = true;
    }

    const result = await Promise.all(this.allFilters.map((f) => f.execute(poolKeys)));
    const resultToConsider = result.filter((r) => this.checkedFilters.includes(r.type));
    const pass = resultToConsider.every((r) => r.ok);

    if (pass) {
      outcome = true;
    }

    for (const filterResult of result.filter((r) => !r.ok)) {
      logger.trace(filterResult.message);
    }

    let results: FilterResult[] = [];

    for (const filterResult of result) {
      results.push(filterResult);
    }

    return { outcome: outcome, allResults: results };
  }
}
