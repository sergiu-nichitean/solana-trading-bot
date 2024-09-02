import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAccount,
  getAssociatedTokenAddress,
  RawAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Liquidity, LiquidityPoolKeysV4, LiquidityStateV4, Percent, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { MarketCache, PoolCache, SnipeListCache } from './cache';
import { PoolFilters, FilterResult } from './filters';
import { TransactionExecutor } from './transactions';
import { createPoolKeys, getPoolSize, logger, NETWORK, sleep, TokenData } from './helpers';
import { Mutex } from 'async-mutex';
import BN from 'bn.js';
import { WarpTransactionExecutor } from './transactions/warp-transaction-executor';
import { JitoTransactionExecutor } from './transactions/jito-rpc-transaction-executor';
import { google } from 'googleapis';

export interface BotConfig {
  wallet: Keypair;
  checkRenounced: boolean;
  checkFreezable: boolean;
  checkBurned: boolean;
  minPoolSize: TokenAmount;
  maxPoolSize: TokenAmount;
  quoteToken: Token;
  quoteAmount: TokenAmount;
  quoteAta: PublicKey;
  oneTokenAtATime: boolean;
  useSnipeList: boolean;
  autoSell: boolean;
  autoBuyDelay: number;
  autoSellDelay: number;
  maxBuyRetries: number;
  maxSellRetries: number;
  unitLimit: number;
  unitPrice: number;
  takeProfit: number;
  stopLoss: number;
  buySlippage: number;
  sellSlippage: number;
  priceCheckInterval: number;
  priceCheckDuration: number;
  filterCheckInterval: number;
  filterCheckDuration: number;
  consecutiveMatchCount: number;
  googleServiceAccountEmail: string;
  googleServiceAccountPrivateKey: string;
  googleSheetId: string;
}

export class Bot {
  private readonly poolFilters: PoolFilters;

  // snipe list
  private readonly snipeListCache?: SnipeListCache;

  // one token at the time
  private readonly mutex: Mutex;
  private sellExecutionCount = 0;
  public readonly isWarp: boolean = false;
  public readonly isJito: boolean = false;

  // Data for google sheet
  private reportingData: TokenData = {};

  constructor(
    private readonly connection: Connection,
    private readonly marketStorage: MarketCache,
    private readonly poolStorage: PoolCache,
    private readonly txExecutor: TransactionExecutor,
    readonly config: BotConfig,
  ) {
    this.isWarp = txExecutor instanceof WarpTransactionExecutor;
    this.isJito = txExecutor instanceof JitoTransactionExecutor;

    this.mutex = new Mutex();
    this.poolFilters = new PoolFilters(connection, {
      quoteToken: this.config.quoteToken,
      minPoolSize: this.config.minPoolSize,
      maxPoolSize: this.config.maxPoolSize,
    });

    if (this.config.useSnipeList) {
      this.snipeListCache = new SnipeListCache();
      this.snipeListCache.init();
    }
  }

  async validate() {
    try {
      await getAccount(this.connection, this.config.quoteAta, this.connection.commitment);
    } catch (error) {
      logger.error(
        `${this.config.quoteToken.symbol} token account not found in wallet: ${this.config.wallet.publicKey.toString()}`,
      );
      return false;
    }

    return true;
  }

  public async buy(accountId: PublicKey, poolState: LiquidityStateV4) {
    logger.debug({ mint: poolState.baseMint }, `Processing new pool...`);

    if (this.config.useSnipeList && !this.snipeListCache?.isInList(poolState.baseMint.toString())) {
      logger.debug({ mint: poolState.baseMint.toString() }, `Skipping buy because token is not in a snipe list`);
      return;
    }

    if (this.config.autoBuyDelay > 0) {
      logger.debug({ mint: poolState.baseMint }, `Waiting for ${this.config.autoBuyDelay} ms before buy`);
      await sleep(this.config.autoBuyDelay);
    }

    if (this.config.oneTokenAtATime) {
      if (this.mutex.isLocked() || this.sellExecutionCount > 0) {
        logger.debug(
          { mint: poolState.baseMint.toString() },
          `Skipping buy because one token at a time is turned on and token is already being processed`,
        );
        return;
      }

      await this.mutex.acquire();
    }

    try {
      const [market, mintAta] = await Promise.all([
        this.marketStorage.get(poolState.marketId.toString()),
        getAssociatedTokenAddress(poolState.baseMint, this.config.wallet.publicKey),
      ]);
      const poolKeys: LiquidityPoolKeysV4 = createPoolKeys(accountId, poolState, market);

      const filterResults = await this.poolFilters.execute(poolKeys);

      logger.trace({ filterResults: filterResults }, 'Filter results.');

      this.reportingData[poolState.baseMint.toString()] = {
        buyTime: '',
        sellTriggerTime: '',
        sellTriggerAmount: '',
        burnedResult: filterResults.allResults.filter((r) => r.type == 'Burn')[0]?.message?.split(' ')[1]!,
        renouncedResult: filterResults.allResults.filter((r) => r.type == 'RenouncedFreeze')[0]?.message?.split(' ')[1].split(',')[0]!,
        freezableResult: filterResults.allResults.filter((r) => r.type == 'RenouncedFreeze')[0]?.message?.split(' ')[3]!,
        mutableResult: filterResults.allResults.filter((r) => r.type == 'MutableSocials')[0]?.message?.split(' ')[1].split(',')[0]!,
        socialsResult: filterResults.allResults.filter((r) => r.type == 'MutableSocials')[0]?.message?.split(' ')[3]!,
        poolSizeResult: filterResults.allResults.filter((r) => r.type == 'PoolSize')[0]?.message?.split(' ')[2]!,
        maxValue: '',
        maxValueTime: '',
      }

      if (!this.config.useSnipeList) {
        const match = filterResults.outcome;

        if (!match) {
          logger.debug({ mint: poolKeys.baseMint.toString() }, `Skipping buy because pool doesn't match filters`);
          return;
        }
      }

      for (let i = 0; i < this.config.maxBuyRetries; i++) {
        try {
          logger.info(
            { mint: poolState.baseMint.toString() },
            `Send buy transaction attempt: ${i + 1}/${this.config.maxBuyRetries}`,
          );
          const tokenOut = new Token(TOKEN_PROGRAM_ID, poolKeys.baseMint, poolKeys.baseDecimals);
          const result = await this.swap(
            poolKeys,
            this.config.quoteAta,
            mintAta,
            this.config.quoteToken,
            tokenOut,
            this.config.quoteAmount,
            this.config.buySlippage,
            this.config.wallet,
            'buy',
          );

          if (result.confirmed) {
            logger.info(
              {
                mint: poolState.baseMint.toString(),
                signature: result.signature,
                url: `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`,
              },
              `Confirmed buy tx`,
            );

            this.reportingData[poolState.baseMint.toString()].buyTime = this.getCurrentTimestamp();

            break;
          }

          logger.info(
            {
              mint: poolState.baseMint.toString(),
              signature: result.signature,
              error: result.error,
            },
            `Error confirming buy tx`,
          );
        } catch (error) {
          logger.debug({ mint: poolState.baseMint.toString(), error }, `Error confirming buy transaction`);
        }
      }
    } catch (error) {
      logger.error({ mint: poolState.baseMint.toString(), error }, `Failed to buy token`);
    } finally {
      if (this.config.oneTokenAtATime) {
        this.mutex.release();
      }
    }
  }

  public async sell(accountId: PublicKey, rawAccount: RawAccount) {
    if (this.config.oneTokenAtATime) {
      this.sellExecutionCount++;
    }

    const currentTokenData = this.reportingData[rawAccount.mint.toString()];

    try {
      logger.trace({ mint: rawAccount.mint }, `Processing new token...`);

      const poolData = await this.poolStorage.get(rawAccount.mint.toString());

      if (!poolData) {
        logger.trace({ mint: rawAccount.mint.toString() }, `Token pool data is not found, can't sell`);
        return;
      }

      const tokenIn = new Token(TOKEN_PROGRAM_ID, poolData.state.baseMint, poolData.state.baseDecimal.toNumber());
      const tokenAmountIn = new TokenAmount(tokenIn, rawAccount.amount, true);

      if (tokenAmountIn.isZero()) {
        logger.info({ mint: rawAccount.mint.toString() }, `Empty balance, can't sell`);
        return;
      }

      if (this.config.autoSellDelay > 0) {
        logger.debug({ mint: rawAccount.mint }, `Waiting for ${this.config.autoSellDelay} ms before sell`);
        await sleep(this.config.autoSellDelay);
      }

      const market = await this.marketStorage.get(poolData.state.marketId.toString());
      const poolKeys: LiquidityPoolKeysV4 = createPoolKeys(new PublicKey(poolData.id), poolData.state, market);

      const amountOut = await this.priceMatch(tokenAmountIn, poolKeys);

      this.reportingData[rawAccount.mint.toString()].sellTriggerTime = this.getCurrentTimestamp();
      this.reportingData[rawAccount.mint.toString()].sellTriggerAmount = amountOut;

      let transactionTotallyFailed = false;

      for (let i = 0; i < this.config.maxSellRetries; i++) {
        try {
          logger.info(
            { mint: rawAccount.mint },
            `Send sell transaction attempt: ${i + 1}/${this.config.maxSellRetries}`,
          );

          const result = await this.swap(
            poolKeys,
            accountId,
            this.config.quoteAta,
            tokenIn,
            this.config.quoteToken,
            tokenAmountIn,
            this.config.sellSlippage,
            this.config.wallet,
            'sell',
          );

          if (result.confirmed) {
            logger.info(
              {
                dex: `https://dexscreener.com/solana/${rawAccount.mint.toString()}?maker=${this.config.wallet.publicKey}`,
                mint: rawAccount.mint.toString(),
                signature: result.signature,
                url: `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`,
              },
              `Confirmed sell tx`,
            );

            const balanceChange = await this.wsolBalanceChange(result.signature!);
            const poolSize = await getPoolSize(poolKeys, this.config.quoteToken, this.connection);

            this.appendGoogleSheetRow(
              [
                [
                  rawAccount.mint.toString(),
                  currentTokenData.buyTime,
                  this.config.quoteAmount.toFixed(),
                  currentTokenData.burnedResult,
                  currentTokenData.renouncedResult,
                  currentTokenData.freezableResult,
                  currentTokenData.mutableResult,
                  currentTokenData.socialsResult,
                  currentTokenData.poolSizeResult,
                  poolSize,
                  currentTokenData.sellTriggerTime,
                  currentTokenData.sellTriggerAmount,
                  this.getCurrentTimestamp(),
                  (i + 1).toString(),
                  balanceChange!.toString(),
                  currentTokenData.maxValue,
                  currentTokenData.maxValueTime,
                  `https://dexscreener.com/solana/${rawAccount.mint.toString()}?maker=${this.config.wallet.publicKey}`
                ]
              ]
            );

            break;
          }

          if (i == this.config.maxSellRetries - 1) {
            transactionTotallyFailed = true;
          }

          logger.info(
            {
              mint: rawAccount.mint.toString(),
              signature: result.signature,
              error: result.error,
            },
            `Error confirming sell tx`,
          );
        } catch (error) {
          if (i == this.config.maxSellRetries - 1) {
            transactionTotallyFailed = true;
          }

          logger.debug({ mint: rawAccount.mint.toString(), error }, `Error confirming sell transaction`);
        }
      }

      if (transactionTotallyFailed) {
        this.appendGoogleSheetRow(
          [
            [
              rawAccount.mint.toString(),
              currentTokenData.buyTime,
              this.config.quoteAmount.toFixed(),
              currentTokenData.burnedResult,
              currentTokenData.renouncedResult,
              currentTokenData.freezableResult,
              currentTokenData.mutableResult,
              currentTokenData.socialsResult,
              currentTokenData.poolSizeResult,
              '',
              currentTokenData.sellTriggerTime,
              currentTokenData.sellTriggerAmount,
              this.getCurrentTimestamp(),
              this.config.maxSellRetries.toString(),
              '0.00',
              currentTokenData.maxValue,
              currentTokenData.maxValueTime,
              ''
            ]
          ]
        );
      }
    } catch (error) {
      this.appendGoogleSheetRow(
        [
          [
            rawAccount.mint.toString(),
            currentTokenData.buyTime,
            this.config.quoteAmount.toFixed(),
            currentTokenData.burnedResult,
            currentTokenData.renouncedResult,
            currentTokenData.freezableResult,
            currentTokenData.mutableResult,
            currentTokenData.socialsResult,
            currentTokenData.poolSizeResult,
            '',
            currentTokenData.sellTriggerTime,
            currentTokenData.sellTriggerAmount,
            this.getCurrentTimestamp(),
            this.config.maxSellRetries.toString(),
            '0.00',
            currentTokenData.maxValue,
            currentTokenData.maxValueTime,
            ''
          ]
        ]
      );

      logger.error({ mint: rawAccount.mint.toString(), error }, `Failed to sell token`);
    } finally {
      if (this.config.oneTokenAtATime) {
        this.sellExecutionCount--;
      }
    }
  }

  // noinspection JSUnusedLocalSymbols
  private async swap(
    poolKeys: LiquidityPoolKeysV4,
    ataIn: PublicKey,
    ataOut: PublicKey,
    tokenIn: Token,
    tokenOut: Token,
    amountIn: TokenAmount,
    slippage: number,
    wallet: Keypair,
    direction: 'buy' | 'sell',
  ) {
    const slippagePercent = new Percent(slippage, 100);
    const poolInfo = await Liquidity.fetchInfo({
      connection: this.connection,
      poolKeys,
    });

    const computedAmountOut = Liquidity.computeAmountOut({
      poolKeys,
      poolInfo,
      amountIn,
      currencyOut: tokenOut,
      slippage: slippagePercent,
    });

    const latestBlockhash = await this.connection.getLatestBlockhash();
    const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
      {
        poolKeys: poolKeys,
        userKeys: {
          tokenAccountIn: ataIn,
          tokenAccountOut: ataOut,
          owner: wallet.publicKey,
        },
        amountIn: amountIn.raw,
        minAmountOut: computedAmountOut.minAmountOut.raw,
      },
      poolKeys.version,
    );

    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [
        ...(this.isWarp || this.isJito
          ? []
          : [
              ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.config.unitPrice }),
              ComputeBudgetProgram.setComputeUnitLimit({ units: this.config.unitLimit }),
            ]),
        ...(direction === 'buy'
          ? [
              createAssociatedTokenAccountIdempotentInstruction(
                wallet.publicKey,
                ataOut,
                wallet.publicKey,
                tokenOut.mint,
              ),
            ]
          : []),
        ...innerTransaction.instructions,
        ...(direction === 'sell' ? [createCloseAccountInstruction(ataIn, wallet.publicKey, wallet.publicKey)] : []),
      ],
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([wallet, ...innerTransaction.signers]);

    return this.txExecutor.executeAndConfirm(transaction, wallet, latestBlockhash);
  }

  private async filterMatch(poolKeys: LiquidityPoolKeysV4) {
    if (this.config.filterCheckInterval === 0 || this.config.filterCheckDuration === 0) {
      return true;
    }

    const timesToCheck = this.config.filterCheckDuration / this.config.filterCheckInterval;
    let timesChecked = 0;
    let matchCount = 0;

    do {
      try {
        const shouldBuy = await this.poolFilters.execute(poolKeys);

        if (shouldBuy) {
          matchCount++;

          if (this.config.consecutiveMatchCount <= matchCount) {
            logger.debug(
              { mint: poolKeys.baseMint.toString() },
              `Filter match ${matchCount}/${this.config.consecutiveMatchCount}`,
            );
            return true;
          }
        } else {
          matchCount = 0;
        }

        await sleep(this.config.filterCheckInterval);
      } finally {
        timesChecked++;
      }
    } while (timesChecked < timesToCheck);

    return false;
  }

  private async priceMatch(amountIn: TokenAmount, poolKeys: LiquidityPoolKeysV4): Promise<string> {
    if (this.config.priceCheckDuration === 0 || this.config.priceCheckInterval === 0) {
      return '';
    }

    const timesToCheck = this.config.priceCheckDuration / this.config.priceCheckInterval;
    const profitFraction = this.config.quoteAmount.mul(this.config.takeProfit).numerator.div(new BN(100));
    const profitAmount = new TokenAmount(this.config.quoteToken, profitFraction, true);
    const takeProfit = this.config.quoteAmount.add(profitAmount);

    const lossFraction = this.config.quoteAmount.mul(this.config.stopLoss).numerator.div(new BN(100));
    const lossAmount = new TokenAmount(this.config.quoteToken, lossFraction, true);
    const stopLoss = this.config.quoteAmount.subtract(lossAmount);
    const slippage = new Percent(this.config.sellSlippage, 100);
    let timesChecked = 0;

    logger.debug(
      { mint: poolKeys.baseMint.toString() },
      `Starting check. timesToCheck: ${timesToCheck}`,
    );

    let finalAmountOut = '';

    do {
      logger.debug(
        { mint: poolKeys.baseMint.toString() },
        `Checking ${timesChecked} time`,
      );

      try {
        const poolInfo = await Liquidity.fetchInfo({
          connection: this.connection,
          poolKeys,
        });

        const amountOut = Liquidity.computeAmountOut({
          poolKeys,
          poolInfo,
          amountIn: amountIn,
          currencyOut: this.config.quoteToken,
          slippage,
        }).amountOut;

        finalAmountOut = amountOut.toFixed();
        const finalAmountOutNumber: number = +finalAmountOut;
        const maxValueNumber = +this.reportingData[poolKeys.baseMint.toString()].maxValue;

        if (finalAmountOutNumber > maxValueNumber) {
          this.reportingData[poolKeys.baseMint.toString()].maxValue = finalAmountOut;
          this.reportingData[poolKeys.baseMint.toString()].maxValueTime = this.getCurrentTimestamp();
        }

        logger.debug(
          { mint: poolKeys.baseMint.toString() },
          `Take profit: ${takeProfit.toFixed()} | Stop loss: ${stopLoss.toFixed()} | Current: ${amountOut.toFixed()}`,
        );

        if (amountOut.lt(stopLoss)) {
          break;
        }

        if (amountOut.gt(takeProfit)) {
          break;
        }

        await sleep(this.config.priceCheckInterval);
      } catch (e) {
        logger.debug({ mint: poolKeys.baseMint.toString(), e }, `Failed to check token price`);
      } finally {
        timesChecked++;
      }
    } while (timesChecked < timesToCheck);

    return finalAmountOut;
  }

  private async appendGoogleSheetRow(values: string[][]) {
    const auth = new google.auth.JWT({
      email: this.config.googleServiceAccountEmail,
      key: this.config.googleServiceAccountPrivateKey,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });

    const sheets = google.sheets('v4');

    try {
      await sheets.spreadsheets.values.append({
        spreadsheetId: this.config.googleSheetId,
        auth: auth,
        range: "New data",
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: values
        }
      });
    } catch (err) {
      logger.error({ error: err }, 'The Google Sheet API returned an error.');
    }
  }

  private getCurrentTimestamp(): string {
    const now = new Date();

    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0'); // Months are zero-based
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }

  private async wsolBalanceChange(signature: string) {
    let transactionData = await this.getTransactionData(signature);
    let retries = 0;

    do {
      await sleep(1000);
      transactionData = await this.getTransactionData(signature);
      retries++;
    } while (transactionData == null && retries < 20);

    const preWsolBalance = transactionData!.meta!.preTokenBalances![3]!.uiTokenAmount!.uiAmount;
    const postWsolBalance = transactionData!.meta!.postTokenBalances![2]!.uiTokenAmount!.uiAmount;

    return postWsolBalance! - preWsolBalance!;
  }

  private async getTransactionData(signature: string) {
    return await this.connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
  }
}
