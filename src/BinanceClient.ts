// src/BinanceFuturesClient.ts
// Рабочая версия под @binance/derivatives-trading-usds-futures@19.0.1 (декабрь 2025)

import {
  DERIVATIVES_TRADING_USDS_FUTURES_REST_API_PROD_URL,
  DERIVATIVES_TRADING_USDS_FUTURES_REST_API_TESTNET_URL,
  DERIVATIVES_TRADING_USDS_FUTURES_WS_API_PROD_URL,
  DERIVATIVES_TRADING_USDS_FUTURES_WS_API_TESTNET_URL,
  DERIVATIVES_TRADING_USDS_FUTURES_WS_STREAMS_PROD_URL,
  DERIVATIVES_TRADING_USDS_FUTURES_WS_STREAMS_TESTNET_URL,
  DerivativesTradingUsdsFutures,
} from '@binance/derivatives-trading-usds-futures';

import { BehaviorSubject, Subject, timer, EMPTY, from } from 'rxjs';
import { mergeMap, retry, catchError, takeUntil } from 'rxjs/operators';

const MAX_RETRIES = 10;
const BASE_DELAY = 1000;

export type Candle = {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  closeTime: number;
  quoteVolume: string;
};

export type Position = {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unrealizedPnL: string;
  leverage: string;
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
};

export class BinanceFuturesClient {
  // Приватные субъекты
  private readonly _candle$ = new BehaviorSubject<Candle | null>(null);
  private readonly _positions$ = new BehaviorSubject<Position[]>([]);
  private readonly _status$ = new BehaviorSubject<'disconnected' | 'connecting' | 'connected'>('disconnected');
  private readonly _destroy$ = new Subject<void>();

  // Публичные стримы
  public readonly candles$ = this._candle$.asObservable();
  public readonly positions$ = this._positions$.asObservable();
  public readonly status$ = this._status$.asObservable();
  
  public get statusValue(): 'disconnected' | 'connecting' | 'connected' {
    return this._status$.value;
  }

  // Клиент и соединения
  private client: DerivativesTradingUsdsFutures;
  private wsStreams: any;
  private wsApi: any;
  private listenKey?: string;

  constructor(
    private apiKey: string,
    private apiSecret: string,
    private testnet = false
  ) {
    const rest = testnet
      ? DERIVATIVES_TRADING_USDS_FUTURES_REST_API_TESTNET_URL
      : DERIVATIVES_TRADING_USDS_FUTURES_REST_API_PROD_URL;
    
    const streams = testnet
      ? DERIVATIVES_TRADING_USDS_FUTURES_WS_STREAMS_TESTNET_URL
      : DERIVATIVES_TRADING_USDS_FUTURES_WS_STREAMS_PROD_URL;

    const apiWs = testnet
      ? DERIVATIVES_TRADING_USDS_FUTURES_WS_API_TESTNET_URL
      : DERIVATIVES_TRADING_USDS_FUTURES_WS_API_PROD_URL;

    this.client = new DerivativesTradingUsdsFutures({
      configurationRestAPI: { apiKey, apiSecret, basePath: rest },
      configurationWebsocketStreams: { wsURL: streams },
      configurationWebsocketAPI: { apiKey, apiSecret, wsURL: apiWs },
    });
  }

  async connect(symbol = 'BTCUSDT', interval = '1m') {
    if (this._status$.value === 'connecting' || this._status$.value === 'connected') {
      return;
    }

    this._status$.next('connecting');

    const attempt = () => from(this.createConnection(symbol, interval)).pipe(
      catchError(err => {
        console.error('Ошибка при подключении:', err);
        throw err; // важно — пробрасываем ошибку дальше, чтобы retry сработал
      })
    );

    attempt()
      .pipe(
        retry({
          delay: (error, retryCount) => {
            const delay = Math.min(1000 * retryCount, 30000);
            console.warn(`Переподключение #${retryCount} через ${delay}мс...`);
            return timer(delay);
          }
        }),
        takeUntil(this._destroy$)
      )
      .subscribe({
        next: () => {
          this._status$.next('connected');
          console.log('Binance Futures — CONNECTED');
        },
        error: () => {
          this._status$.next('disconnected');
        }
      });
  }

  private async createConnection(symbol: string, interval: string) {
    let listenKey: string;
    
    // 1. ListenKey
    try {
      const lkResponse: any = await this.client.restAPI.startUserDataStream();
      const data = await lkResponse.data();
      listenKey = data.listenKey;
      this.listenKey = listenKey;
      console.log('listenKey', listenKey);
    } catch (e) {
      console.error("❌ Ошибка при получении listenKey. Проверьте ключи/права/IP:", e);
      throw new Error("LISTEN_KEY_FETCH_FAILED");
    }

    // 2. Streams
    this.wsStreams = await this.client.websocketStreams.connect({
      stream: [`${symbol.toLowerCase()}@kline_${interval}`, `${listenKey}@userData`],
    });

    try {
      // ✅ ИСПРАВЛЕНО: Для combined stream — слушаем 'message' на connection, парсим и роутим
      this.wsStreams.on('message', (data: string) => {
        try {
          const msg = JSON.parse(data);
          if (msg.stream === `${symbol.toLowerCase()}@kline_${interval}` && msg.data.k?.x) {
            this._candle$.next({
              openTime: msg.data.k.t,
              open: msg.data.k.o,
              high: msg.data.k.h,
              low: msg.data.k.l,
              close: msg.data.k.c,
              volume: msg.data.k.v,
              closeTime: msg.data.k.T,
              quoteVolume: msg.data.k.q,
            });
          } else if (msg.stream === `${listenKey}@userData` && (msg.data.e === 'ACCOUNT_UPDATE' || msg.data.e === 'ORDER_TRADE_UPDATE')) {
            this.updatePositions();
          }
        } catch (e) {
          console.warn('Message parse error', e);
        }
      });
    } catch (e) {
      console.error("❌ КРИТИЧЕСКАЯ ОШИБКА: Сбой при подписке на WS потоки:", e);
      throw new Error("WS_SUBSCRIPTION_FAILED");
    }

    // 3. WS API для ордеров
    this.wsApi = await this.client.websocketAPI.connect();

    // 4. Keep-alive listenKey
    timer(0, 25 * 60 * 1000)
      .pipe(
        mergeMap(() => this.client.restAPI.keepaliveUserDataStream()),
        takeUntil(this._destroy$)
      )
      .subscribe();

    await this.updatePositions();
  }

  // ———————————————————————— Методы —————————————————

  async enableHedgeMode() {
    try {
      await this.client.restAPI.changePositionMode({ dualSidePosition: 'true' });
    } catch (e: any) {
      console.log('Controlled error: ', e)
    }
  }

  async disableHedgeMode() {
    await this.client.restAPI.changePositionMode({ dualSidePosition: 'false' });
  }

  async setLeverage(symbol: string, leverage: number) {
    try {
      await this.client.restAPI.changeInitialLeverage({ symbol, leverage });
    } catch (e: any) {
      console.log('Controlled error: ', e)
    }
  }

  private async getCurrentPrice(symbol: string): Promise<number> {
    const data: any = await this.client.restAPI.ticker24hrPriceChangeStatistics({ symbol });
    const price = await data.data();
    return parseFloat(price.lastPrice); 
  }

  private async getSymbolInfo(symbol: string) {
    try {
      const info: any = await this.client.restAPI.exchangeInformation();
      console.log('info', info)
      const s = info.symbols.find((x: any) => x.symbol === symbol);
      if (!s) throw new Error('Symbol not found');

      const lot = s.filters.find((f: any) => f.filterType === 'LOT_SIZE');
      const price = s.filters.find((f: any) => f.filterType === 'PRICE_FILTER');

      return {
        minQty: Number(lot.minQty),
        stepSize: Number(lot.stepSize),
        precision: lot.stepSize.split('.')[1]?.length || 0,
        tickSize: Number(price.tickSize),
      };
    } catch (e) {
      console.log(e)
    }
  }

  async marketOrderByUsd({
    symbol,
    side,
    usdAmount,
    positionSide = 'BOTH',
  }: {
    symbol: string;
    side: 'BUY' | 'SELL';
    usdAmount: number;
    positionSide?: 'BOTH' | 'LONG' | 'SHORT';
  }) {
    try {
      const price = await this.getCurrentPrice(symbol);
      const info: any = await this.getSymbolInfo(symbol);
      console.log('info', info);

      let qty = usdAmount / price;
      qty = Math.floor(qty / info.stepSize) * info.stepSize;
      if (qty < info.minQty) throw new Error('Order too small');

      const quantity = qty.toFixed(info.precision);

      return this.wsApi.newOrder({
        symbol,
        side,
        type: 'MARKET',
        quantity,
        positionSide,
      });
    } catch(e){
      console.log('ERROR', e)
    }
  }

  async getKlines(symbol: string, interval: string, limit = 500): Promise<Candle[]> {
    const response: any = await this.client.restAPI.klineCandlestickData({
        symbol,
        interval: interval as any,
        limit
    });
    const data: any[] = await response.data(); 
    console.log(data);
    return data.map((k: any[]) => ({
      openTime: k[0],
      open: k[1],
      high: k[2],
      low: k[3],
      close: k[4],
      volume: k[5],
      closeTime: k[6],
      quoteVolume: k[7],
    }));
  }

  private async updatePositions() {
    try {
      const accResponse: any = await this.client.restAPI.accountInformationV2();
      const acc: any = await accResponse.data();

      // ✅ ФИНАЛЬНОЕ ИСПРАВЛЕНИЕ #1: acc.positions — это уже массив позиций.
      const positions = Array.isArray(acc.positions)
        ? acc.positions
            .filter((p: any) => Number(p.positionAmt) !== 0)
            .map((p: any) => ({
                symbol: p.symbol,
                positionAmt: p.positionAmt,
                entryPrice: p.entryPrice,
                markPrice: p.markPrice,
                unrealizedPnL: p.unrealizedProfit,
                leverage: p.leverage,
                positionSide: p.positionSide as Position['positionSide'],
            }))
        : []; 

      this._positions$.next(positions);
    } catch (e) {
      console.warn('Failed to update positions', e);
    }
  }

  async closePosition(symbol: string, positionSide: 'LONG' | 'SHORT' | 'BOTH' = 'BOTH') {
    const positions = this._positions$.value;
    const pos = positions.find(p => p.symbol === symbol && p.positionSide === positionSide);
    if (!pos || Number(pos.positionAmt) === 0) return;

    const side = Number(pos.positionAmt) > 0 ? 'SELL' : 'BUY';

    return this.wsApi.newOrder({
      symbol,
      side,
      type: 'MARKET',
      quantity: Math.abs(Number(pos.positionAmt)).toFixed(8),
      positionSide,
    });
  }

  destroy() {
    this._destroy$.next();
    this._destroy$.complete();
    this.wsStreams?.close();
    this.wsApi?.close();
    this._status$.next('disconnected');
  }
}