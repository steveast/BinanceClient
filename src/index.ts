// binanceFuturesClient.final.v19-fixed.ts
// Актуально для @binance/derivatives-trading-usds-futures@^19.0.1 (декабрь 2025)

import {
  DERIVATIVES_TRADING_USDS_FUTURES_REST_API_PROD_URL,
  DERIVATIVES_TRADING_USDS_FUTURES_REST_API_TESTNET_URL,
  DERIVATIVES_TRADING_USDS_FUTURES_WS_API_PROD_URL,
  DERIVATIVES_TRADING_USDS_FUTURES_WS_API_TESTNET_URL,
  DERIVATIVES_TRADING_USDS_FUTURES_WS_STREAMS_PROD_URL,
  DERIVATIVES_TRADING_USDS_FUTURES_WS_STREAMS_TESTNET_URL,
  DerivativesTradingUsdsFutures,
} from '@binance/derivatives-trading-usds-futures';
import { BehaviorSubject, EMPTY, from, Subject, timer } from 'rxjs';
import { catchError, delayWhen, retryWhen, switchMap, take, takeUntil, tap } from 'rxjs/operators';

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
  private isTestnet: boolean;
  private client: DerivativesTradingUsdsFutures;
  private wsStreamsConnection?: any; // WebsocketStreamsConnection
  private wsApiConnection?: any; // WebsocketAPIBase
  private listenKey?: string;
  private userDataStream?: any; // WebsocketStream for user data
  private klineStream?: any; // WebsocketStream for klines

  private candleSubject = new BehaviorSubject<Candle | null>(null);
  private positionSubject = new BehaviorSubject<Position[]>([]);
  private statusSubject = new BehaviorSubject<'disconnected' | 'connecting' | 'connected'>(
    'disconnected'
  );
  private destroy$ = new Subject<void>();

  public candles$ = this.candleSubject.asObservable();
  public positions$ = this.positionSubject.asObservable();
  public status$ = this.statusSubject.asObservable();

  constructor(
    private apiKey: string,
    private apiSecret: string,
    options: { testnet?: boolean } = {}
  ) {
    this.isTestnet = options.testnet ?? false;
    const basePath = this.isTestnet
      ? DERIVATIVES_TRADING_USDS_FUTURES_REST_API_TESTNET_URL
      : DERIVATIVES_TRADING_USDS_FUTURES_REST_API_PROD_URL;

    // Для WS: wsURL вместо baseUrl (по примерам на npm)
    const wsStreamsWsUrl = this.isTestnet
      ? DERIVATIVES_TRADING_USDS_FUTURES_WS_STREAMS_TESTNET_URL
      : DERIVATIVES_TRADING_USDS_FUTURES_WS_STREAMS_PROD_URL;
    const wsApiWsUrl = this.isTestnet
      ? DERIVATIVES_TRADING_USDS_FUTURES_WS_API_TESTNET_URL
      : DERIVATIVES_TRADING_USDS_FUTURES_WS_API_PROD_URL;

    this.client = new DerivativesTradingUsdsFutures({
      configurationRestAPI: { apiKey, apiSecret, basePath },
      configurationWebsocketStreams: { wsURL: wsStreamsWsUrl },
      configurationWebsocketAPI: { apiKey, apiSecret, wsURL: wsApiWsUrl }, // Added apiKey and apiSecret
    });
  }

  async connect(symbol: string = 'BTCUSDT', interval: string = '1m') {
    if (this.statusSubject.value === 'connecting') {
      return;
    }
    this.statusSubject.next('connecting');

    timer(0, 5000)
      .pipe(
        switchMap(() => this.createConnection(symbol, interval)),
        retryWhen((errors) =>
          errors.pipe(
            tap((err) => console.warn('Reconnecting...', err.message || err)),
            delayWhen((_, i) => timer(Math.min(BASE_DELAY * 2 ** i, 60_000))),
            take(MAX_RETRIES)
          )
        ),
        catchError((err) => {
          console.error('Connection failed permanently', err);
          this.statusSubject.next('disconnected');
          return EMPTY;
        }),
        takeUntil(this.destroy$)
      )
      .subscribe(() => {
        this.statusSubject.next('connected');
        console.log('Binance Futures connected');
      });
  }

  private async createConnection(symbol: string, interval: string) {
    this.listenKey = await this.getListenKeyWithRetry();

    // Подключаем WS Streams (без extra params — wsURL из config)
    this.wsStreamsConnection = await this.client.websocketStreams.connect({
      stream: [`${symbol.toLowerCase()}@kline_${interval}`, `userData@${this.listenKey}`], // Мульти-стрим
      mode: 'single',
    });

    // Создаём стримы (подписка через создание после connect)
    this.userDataStream = this.wsStreamsConnection.userData(this.listenKey);
    this.klineStream = this.wsStreamsConnection.kline(symbol, interval);

    // Обработчики сообщений (string data, parse JSON)
    this.userDataStream.on('message', (data: string) => {
      try {
        const parsed = JSON.parse(data);
        if (parsed.e === 'ACCOUNT_UPDATE' || parsed.e === 'ORDER_TRADE_UPDATE') {
          this.updatePositions();
        }
      } catch (e) {
        console.warn('User data parse error:', e);
      }
    });

    this.klineStream.on('message', (data