import { Filter, FilterResult } from './pool-filters';
import { Connection } from '@solana/web3.js';
import { LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';
import { getPdaMetadataKey } from '@raydium-io/raydium-sdk';
import { MetadataAccountData, MetadataAccountDataArgs } from '@metaplex-foundation/mpl-token-metadata';
import { Serializer } from '@metaplex-foundation/umi/serializers';
import { logger } from '../helpers';

export class MutableFilter implements Filter {
  private readonly errorMessage: string[] = [];

  constructor(
    private readonly connection: Connection,
    private readonly metadataSerializer: Serializer<MetadataAccountDataArgs, MetadataAccountData>,
    private readonly checkMutable: boolean,
    private readonly checkSocials: boolean,
  ) {
    if (this.checkMutable) {
      this.errorMessage.push('mutable');
    }

    if (this.checkSocials) {
      this.errorMessage.push('socials');
    }
  }

  async execute(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
    try {
      const metadataPDA = getPdaMetadataKey(poolKeys.baseMint);
      const metadataAccount = await this.connection.getAccountInfo(metadataPDA.publicKey, this.connection.commitment);

      if (!metadataAccount?.data) {
        return { ok: false, type: 'MutableSocials', message: 'Mutable: -, Socials: -' };
      }

      const deserialize = this.metadataSerializer.deserialize(metadataAccount.data);
      const mutable =  deserialize[0].isMutable;
      const hasSocials = await this.hasSocials(deserialize[0]);
      const ok = (!this.checkMutable || !mutable) && (!this.checkSocials || hasSocials);

      return { ok: ok, type: 'MutableSocials', message: `Mutable: ${mutable}, Socials: ${hasSocials}` };
    } catch (e) {
      logger.error({ mint: poolKeys.baseMint }, `MutableSocials -> Failed to check ${this.errorMessage.join(' and ')}`);
    }

    return {
      ok: false,
      type: 'MutableSocials',
      message: 'Mutable: -, Socials: -',
    };
  }

  private async hasSocials(metadata: MetadataAccountData) {
    const response = await fetch(metadata.uri);
    const data = await response.json();
    return Object.values(data?.extensions ?? {}).some((value: any) => value !== null && value.length > 0);
  }
}
