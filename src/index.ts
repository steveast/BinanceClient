// src/BinanceFuturesClient.ts

import {
  DERIVATIVES_TRADING_USDS_FUTURES_REST_API_PROD_URL,
  DERIVATIVES_TRADING_USDS_FUTURES_REST_API_TESTNET_URL,
  DERIVATIVES_TRADING_USDS_FUTURES_WS_API_PROD_URL,
  DERIVATIVES_TRADING_USDS_FUTURES_WS_API_TESTNET_URL,
  DERIVATIVES_TRADING_USDS_FUTURES_WS_STREAMS_PROD_URL,
  DERIVATIVES_TRADING_USDS_FUTURES_WS_STREAMS_TESTNET_URL,
  DerivativesTradingUsdsFutures,
} from '@binance/derivatives-trading-usds-futures';

import { BehaviorSubject, Subject, timer, EMPTY } from 'rxjs';
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
    if (this._status$.value === 'connecting') return;

    this._status$.next('connecting');

    timer(0, 5000)
      .pipe(
        mergeMap(() => this.createConnection(symbol, interval)),
        retry({
          count: MAX_RETRIES,
          delay: (_, i) => {
            const delay = Math.min(BASE_DELAY * 2 ** i, 60_000);
            console.warn(`Reconnect attempt ${i + 1}/${MAX_RETRIES} in ${delay}ms`);
            return timer(delay);
          },
        }),
        catchError(err => {
          console.error('Connection failed permanently:', err);
          this._status$.next('disconnected');
          return EMPTY;
        }),
        takeUntil(this._destroy$)
      )
      .subscribe(() => {
        this._status$.next('connected');
        console.log('Binance Futures — CONNECTED');
      });
  }

  private async createConnection(symbol: string, interval: string) {
    // 1. ListenKey (TS2339)
    // ✅ ИСПРАВЛЕНО: Приводим ответ к 'any' для корректного доступа к .data()
    const lkResponse: any = await this.client.restAPI.startUserDataStream();
    const { listenKey } = lkResponse.data(); 
    this.listenKey = listenKey;

    // 2. Streams
    this.wsStreams = await this.client.websocketStreams.connect({
      stream: [`${symbol.toLowerCase()}@kline_${interval}`, `${listenKey}@userData`],
    });

    const klineStream = this.wsStreams.kline(symbol, interval);
    const userStream = this.wsStreams.userData(listenKey);

    klineStream.on('message', (data: string) => {
      try {
        const msg = JSON.parse(data);
        if (msg.k?.x) {
          this._candle$.next({
            openTime: msg.k.t,
            open: msg.k.o,
            high: msg.k.h,
            low: msg.k.l,
            close: msg.k.c,
            volume: msg.k.v,
            closeTime: msg.k.T,
            quoteVolume: msg.k.q,
          });
        }
      } catch {}
    });

    userStream.on('message', () => this.updatePositions());

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
    await this.client.restAPI.changePositionMode({ dualSidePosition: 'true' });
  }

  async disableHedgeMode() {
    await this.client.restAPI.changePositionMode({ dualSidePosition: 'false' });
  }

  async setLeverage(symbol: string, leverage: number) {
    await this.client.restAPI.changeInitialLeverage({ symbol, leverage });
  }

  private async getCurrentPrice(symbol: string): Promise<number> {
    // ✅ ИСПРАВЛЕНО: Приводим ответ к 'any'
    const data: any = await this.client.restAPI.ticker24hrPriceChangeStatistics({ symbol });
    return Number(data.data().lastPrice); 
  }

  private async getSymbolInfo(symbol: string) {
    // ✅ ИСПРАВЛЕНО: Приводим ответ к 'any'
    const info: any = await this.client.restAPI.exchangeInformation();
    const { symbols } = info.data(); 
    const s = symbols.find((x: any) => x.symbol === symbol);
    if (!s) throw new Error('Symbol not found');

    const lot = s.filters.find((f: any) => f.filterType === 'LOT_SIZE');
    const price = s.filters.find((f: any) => f.filterType === 'PRICE_FILTER');

    return {
      minQty: Number(lot.minQty),
      stepSize: Number(lot.stepSize),
      precision: lot.stepSize.includes('.') ? lot.stepSize.split('.')[1].length : 0,
      tickSize: Number(price.tickSize),
    };
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
    const price = await this.getCurrentPrice(symbol);
    const info = await this.getSymbolInfo(symbol);

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
  }

  async getKlines(symbol: string, interval: string, limit = 500): Promise<Candle[]> {
    // ✅ ИСПРАВЛЕНО: Приводим ответ к 'any'
    const response: any = await this.client.restAPI.klineCandlestickData({
        symbol,
        interval: interval as any,
        limit
    });
    // ✅ ИСПРАВЛЕНО: .data() теперь возвращает 'any[]'
    const data: any[] = response.data(); 
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
      // ✅ ИСПРАВЛЕНО: Приводим ответ к 'any'
      const accResponse: any = await this.client.restAPI.accountInformationV2();
      const acc: any = accResponse.data();
      const positions = acc.assets
        .flatMap((asset: any) => asset.positions)
        .filter((p: any) => Number(p.positionAmt) !== 0)
        .map((p: any) => ({
          symbol: p.symbol,
          positionAmt: p.positionAmt,
          entryPrice: p.entryPrice,
          markPrice: p.markPrice,
          unrealizedPnL: p.unrealizedProfit,
          leverage: p.leverage,
          positionSide: p.positionSide as Position['positionSide'],
        }));
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