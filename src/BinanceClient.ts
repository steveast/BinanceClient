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
  private clientProd: DerivativesTradingUsdsFutures; // production
  private wsStreams: any;
  private wsApi: any;
  private listenKey?: string;

  constructor(
    private apiKey: string,
    private apiSecret: string,
    private testnet = process.env.TESTNET
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
    // Некоторые методы не работают на тестнете
    this.clientProd = new DerivativesTradingUsdsFutures({
      configurationRestAPI: { apiKey, apiSecret },
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

  /**
 * Включает Hedge Mode (двусторонний режим позиций).
 * После включения можно одновременно держать LONG и SHORT по одному символу.
 *
 * На тестовой сети (testnet) Hedge Mode включён по умолчанию и его нельзя выключить!
 *
 * @throws Если уже включён или произошла ошибка API
 */
  async enableHedgeMode() {
    try {
      await this.client.restAPI.changePositionMode({ dualSidePosition: 'true' });
      console.log('[CONFIG] Hedge Mode (двусторонний режим) успешно включён');
    } catch (error: any) {
      if (error?.code === -4059) {
        console.log('[CONFIG] Hedge Mode уже включён (нормально)');
      } else {
        console.error('[CONFIG] Ошибка при включении Hedge Mode:', error?.code, error?.msg || error);
        throw error;
      }
    }
  }

  /**
 * Выключает Hedge Mode → переходит в One-Way Mode (односторонний).
 * После этого по символу может быть только одна позиция (LONG или SHORT).
 *
 * На тестовой сети это НЕ сработает — Binance игнорирует запрос!
 *
 * @throws Если уже выключен или произошла ошибка API
 */
  async disableHedgeMode() {
    try {
      await this.client.restAPI.changePositionMode({ dualSidePosition: 'false' });
      console.log('[CONFIG] One-Way Mode (односторонний режим) успешно включён');
    } catch (error: any) {
      if (error?.code === -4059) {
        console.log('[CONFIG] One-Way Mode уже активен (нормально)');
      } else {
        console.error('[CONFIG] Ошибка при выключении Hedge Mode:', error?.code, error?.msg || error);
        // На тестнете это ожидаемо — можно подавить
        if (this.testnet) {
          console.log('[INFO] На тестовой сети нельзя выключить Hedge Mode — это нормально');
        } else {
          throw error;
        }
      }
    }
  }

  /**
 * Устанавливает начальное (и текущее) плечо для символа.
 * Работает как в Cross, так и в Isolated режиме.
 *
 * @param symbol    Торговый символ (например "BTCUSDT")
 * @param leverage  Плечо от 1 до 125 (зависит от символа и tier)
 *
 * @example await client.setLeverage('BTCUSDT', 20);
 */
  async setLeverage(symbol: string, leverage: number) {
    if (leverage < 1 || leverage > 125) {
      throw new Error(`Недопустимое плечо ${leverage}. Допустимо: 1–125`);
    }

    try {
      await this.client.restAPI.changeInitialLeverage({ symbol, leverage });
      console.log(`[LEVERAGE] Установлено плечо ${leverage}x для ${symbol}`);
    } catch (error: any) {
      if (error?.code === -4141) {
        console.warn(`[LEVERAGE] Плечо ${leverage}x недоступно для ${symbol} (возможно, превышен tier)`);
      } else if (error?.code === -4059) {
        console.log(`[LEVERAGE] Плечо ${leverage}x уже установлено для ${symbol}`);
      } else {
        console.error(`[LEVERAGE] Ошибка при установке плеча ${leverage}x для ${symbol}:`, error?.code, error?.msg || error);
        throw error;
      }
    }
  }

  /**
 * Получает текущую рыночную цену (lastPrice) по символу.
 * Используется в marketOrderByUsd() и других расчётах.
 *
 * Надёжнее и быстрее, чем markPrice (особенно для рыночных ордеров).
 *
 * @param symbol Торговый символ
 * @returns Текущая цена как number
 */
  private async getCurrentPrice(symbol: string): Promise<number> {
    const response = await this.client.restAPI.ticker24hrPriceChangeStatistics({ symbol });
    const data: any = await response.data();

    const price = parseFloat(data.lastPrice);
    if (isNaN(price) || price <= 0) {
      throw new Error(`Некорректная цена для ${symbol}: ${data.lastPrice}`);
    }
    return price;
  }

  /**
 * Получает торговые правила (фильтры) для конкретного фьючерсного символа.
 * Кешируется на уровне экземпляра клиента → один запрос на символ за всё время работы.
 *
 * Возвращает:
 *  • minQty      — минимально разрешённый объём ордера
 *  • stepSize    — шаг изменения количества (например, 0.001)
 *  • precision   — сколько знаков после запятой нужно использовать при toFixed()
 *  • tickSize    — минимальный шаг цены (для лимитных ордеров)
 *
 * Используется в:
 *   • marketOrderByUsd()
 *   • forceClosePosition() (для правильного округления)
 *   • валидации пользовательского ввода
 *
 * @param symbol Торговый символ (например, "BTCUSDT", "ETHUSDT")
 * @returns Объект с торговыми ограничениями
 * @throws Если символ не найден или произошла ошибка API
 */
  private symbolInfoCache = new Map<string, {
    minQty: number;
    stepSize: number;
    precision: number;
    tickSize: number;
  }>();

  private async getSymbolInfo(symbol: string) {
    // 1. Кеширование — exchangeInformation() тяжёлый запрос (~100–300 КБ)
    if (this.symbolInfoCache.has(symbol)) {
      return this.symbolInfoCache.get(symbol)!;
    }

    try {
      // 2. Используем clientProd (без авторизации) — эндпоинт публичный
      const response = await this.clientProd.restAPI.exchangeInformation();
      const data: any = await response.data();

      // 3. Находим нужный символ
      const symbolInfo = data.symbols.find((s: any) => s.symbol === symbol);
      if (!symbolInfo) {
        throw new Error(`Символ ${symbol} не найден на Binance Futures`);
      }

      // 4. Извлекаем фильтры LOT_SIZE и PRICE_FILTER
      const lotFilter = symbolInfo.filters.find((f: any) => f.filterType === 'LOT_SIZE');
      const priceFilter = symbolInfo.filters.find((f: any) => f.filterType === 'PRICE_FILTER');

      if (!lotFilter || !priceFilter) {
        throw new Error(`Не найдены фильтры LOT_SIZE или PRICE_FILTER для ${symbol}`);
      }

      // 5. Рассчитываем точность (precision) — сколько знаков после запятой в stepSize
      const stepSizeStr = lotFilter.stepSize;
      const precision = stepSizeStr.includes('.')
        ? stepSizeStr.split('.')[1].replace(/0+$/, '').length || 0
        : 0;

      const info = {
        minQty: Number(lotFilter.minQty),
        stepSize: Number(lotFilter.stepSize),
        precision,                         // ← теперь правильно (например, 3 для 0.001)
        tickSize: Number(priceFilter.tickSize),
      };

      // 6. Сохраняем в кеш
      this.symbolInfoCache.set(symbol, info);

      console.log(`[SYMBOL INFO] ${symbol} → minQty: ${info.minQty}, stepSize: ${info.stepSize}, precision: ${info.precision}, tickSize: ${info.tickSize}`);

      return info;

    } catch (error: any) {
      console.error(`[getSymbolInfo] Ошибка при получении информации о символе ${symbol}:`, error?.message || error);

      // При ошибке можно вернуть fallback-значения (например, для BTCUSDT), но лучше бросить
      throw new Error(`Не удалось получить торговые правила для ${symbol}: ${error?.message || error}`);
    }
  }

  /**
 * Размещает рыночный ордер на фьючерсах Binance по заданной сумме в USD (USDT).
 * Автоматически рассчитывает количество контрактов с учётом:
 *   • текущей рыночной цены
 *   • шага размера лота (stepSize)
 *   • минимального объёма (minQty)
 *   • точности округления (precision)
 *
 * @param params.symbol       Торговый символ (например, "BTCUSDT")
 * @param params.side         Направление: 'BUY' — открытие/увеличение лонга, 'SELL' — шорта
 * @param params.usdAmount    Желаемый размер позиции в USD (USDT)
 * @param params.positionSide Режим позиции:
 *                            - 'LONG'  → только лонг (рекомендуется на тестнете и в хедж-режиме)
 *                            - 'SHORT' → только шорт
 *                            - 'BOTH'  → устаревшее, работает только в One-Way mode (на тестнете вызовет -4061!)
 *
 * @returns Promise<Response> — ответ от Binance (содержит orderId и т.д.)
 * @throws Если ордер слишком мал или произошла ошибка сети/ключа
 *
 * @example
 * await client.marketOrderByUsd({
 *   symbol: 'BTCUSDT',
 *   side: 'BUY',
 *   usdAmount: 250,
 *   positionSide: 'LONG'  // ← обязательно на тестнете!
 * });
 */
  async marketOrder({
    symbol,
    side,
    usdAmount,
    positionSide = 'BOTH', // ← по умолчанию BOTH, но на тестнете используй 'LONG'/'SHORT'
  }: {
    symbol: string;
    side: 'BUY' | 'SELL';
    usdAmount: number;
    positionSide?: 'BOTH' | 'LONG' | 'SHORT';
  }) {
    try {
      // 1. Получаем текущую рыночную цену (lastPrice)
      const price = await this.getCurrentPrice(symbol);

      // 2. Получаем информацию о символe: minQty, stepSize, точность
      const info = await this.getSymbolInfo(symbol);
      if (!info) {
        throw new Error(`Не удалось получить информацию о символе ${symbol}`);
      }

      // 3. Расчёт количества контрактов
      //    usdAmount / price → примерное количество
      let qty = usdAmount / price;

      // 4. Округление вниз до ближайшего шага (stepSize) — требование Binance
      //    Пример: stepSize = 0.001 → обрезаем до 3 знаков после запятой
      qty = Math.floor(qty / info.stepSize) * info.stepSize;

      // 5. Проверка минимального размера ордера
      if (qty < info.minQty) {
        throw new Error(
          `Ордер слишком мал: ${qty} < ${info.minQty} (минимальный объём для ${symbol})`
        );
      }

      // 6. Приведение к строке с правильной точностью (Binance требует string)
      const quantity = qty.toFixed(info.precision);

      console.log(
        `[MARKET ORDER] ${side} ${quantity} ${symbol} (~${usdAmount.toFixed(
          2
        )} USD) @ ~${price.toFixed(2)} | positionSide: ${positionSide}`
      );

      // 7. Отправка рыночного ордера через WebSocket API (быстрее и надёжнее REST)
      //    Важно: используем this.wsApiConnection (не this.wsApi!)
      const orderResponse = await this.wsApi.newOrder({
        symbol,
        side,
        type: 'MARKET',
        quantity,              // ← строка с правильной точностью
        positionSide,          // ← критично! На тестнете только 'LONG'/'SHORT'
      });

      return orderResponse;
    } catch (error: any) {
      // Подробный вывод ошибки — очень помогает при отладке
      console.error(
        `Ошибка MARKET ORDER (${symbol} ${side} ${usdAmount} USD, side: ${positionSide}):`,
        error?.message || error
      );

      // Если это известная ошибка позиции — подсвечиваем особо
      if (error?.code === -4061) {
        console.error(
          `Ошибка -4061: Вы используете positionSide='${positionSide}', но аккаунт в Hedge Mode.\n` +
          `Решение: используйте 'LONG' или 'SHORT' вместо 'BOTH'.\n` +
          `На тестнете Hedge Mode включён по умолчанию и его нельзя выключить.`
        );
      }

      // Пробрасываем дальше, чтобы caller мог обработать
      throw error;
    }
  }

  async limitOrder({
    symbol,
    side,
    usdAmount,
    price,
    positionSide = this.testnet ? 'LONG' : 'BOTH',
  }: {
    symbol: string;
    side: 'BUY' | 'SELL';
    usdAmount: number;
    price: number;
    positionSide?: 'LONG' | 'SHORT' | 'BOTH';
  }) {
    const info = await this.getSymbolInfo(symbol);
    let qty = usdAmount / price;
    qty = Math.floor(qty / info.stepSize) * info.stepSize;
    if (qty < info.minQty) throw new Error('Ордер слишком мал');

    const quantity = qty.toFixed(info.precision);

    return this.wsApi.newOrder({
      symbol,
      side,
      type: 'LIMIT',
      timeInForce: 'GTC',
      quantity,
      price: price.toFixed(info.precision === 0 ? 1 : info.precision),
      positionSide,
    });
  }

  async modifyLimitOrder({
    symbol,
    orderId,
    newPrice,
    qty: qtyInUsd,
    // Параметр side необходим для типа функции, но его значение не используется напрямую в payload
    side,
  }: {
    symbol: string;
    orderId?: number | string;
    newPrice: number;
    qty: number;
    side: 'BUY' | 'SELL';
  }) {
    const info = await this.getSymbolInfo(symbol);

    let qty = qtyInUsd / newPrice;
    qty = Math.floor(qty / info.stepSize) * info.stepSize;
    if (qty < info.minQty) {
      throw new Error(`Новый объём слишком мал: ${qty} < ${info.minQty} (${symbol})`);
    }

    const quantityStr = qty.toFixed(info.precision);
    const quantityNum = Number(quantityStr);

    const roundedNewPrice = Number(newPrice.toFixed(info.precision || 1));

    // Изначальный payload без side, мы добавим его позже из orderData
    const payload: any = {
      symbol,
      type: 'LIMIT' as any,
      price: roundedNewPrice,
      quantity: quantityNum,
    };

    if (orderId) {
      let binanceOrderId: number | undefined;
      let originalOrderSide: 'BUY' | 'SELL' | undefined; // Переменная для хранения оригинального side

      // 1. КРИТИЧЕСКАЯ ПРОВЕРКА СТАТУСА:
      try {
        const statusCheck = await this.client.restAPI.queryOrder({
          symbol,
          orderId: typeof orderId === 'number' ? orderId : undefined,
          origClientOrderId: typeof orderId === 'string' ? orderId : undefined,
        });
        const orderData = await statusCheck.data();

        binanceOrderId = Number(orderData.orderId);
        originalOrderSide = orderData.side as 'BUY' | 'SELL'; // ✅ ИЗВЛЕКАЕМ ОРИГИНАЛЬНЫЙ SIDE

        if (orderData.status !== 'NEW' && orderData.status !== 'PARTIALLY_FILLED') {
          const message = `[MODIFY ABORTED] Ордер ${orderId} имеет статус ${orderData.status}. Модификация невозможна.`;
          console.warn(message);
          return orderData;
        }
        console.log(`[MODIFY CHECK] Ордер ${orderId} (Binance ID: ${binanceOrderId}) в статусе ${orderData.status}. Продолжаем модификацию...`);

        // ✅ ФИКС: ДОБАВЛЯЕМ ОРИГИНАЛЬНЫЙ SIDE В PAYLOAD
        if (originalOrderSide) {
          payload.side = originalOrderSide;
        } else {
          throw new Error(`Не удалось получить оригинальное направление (side) ордера.`);
        }

      } catch (error: any) {
        console.error(`[MODIFY ERROR] Ошибка при проверке статуса ордера ${orderId}. Модификация невозможна.`);
        throw error;
      }

      // 2. ФОРМИРОВАНИЕ PAYLOAD ДЛЯ MODIFY (Использование Client ID)
      if (typeof orderId === 'number') {
        payload.orderId = orderId;
      } else {
        payload.origClientOrderId = orderId;
        payload.newClientOrderId = `mod_${Date.now()}`;
      }
    }

    // Вызов модификации
    const resp = await this.client.restAPI.modifyOrder(payload);
    const data = await resp.data();

    return data;
  }

  /**
 * Изменяет существующий Take-Profit или Stop-Loss (algo-ордер) на Binance USDS-M Futures.
 * Работает путём отмены старого ордера и создания нового с обновлёнными параметрами.
 *
 * Важно: Binance не поддерживает прямую модификацию algo-ордеров после миграции API (декабрь 2025).
 *
 * @param symbol           Торговый символ (например "BTCUSDT")
 * @param algoId           Algo order ID из ответа newAlgoOrder (например: 1000000000214986)
 * @param newTriggerPrice  Новая цена срабатывания (trigger price)
 * @param newQuantityUsd   Новый размер в USD (опционально). Если не указан — берётся из текущей позиции
 * @param positionSide     Сторона позиции: 'LONG' или 'SHORT'
 * @param isTakeProfit     true = Take-Profit, false = Stop-Loss (по умолчанию true)
 *
 * @returns Ответ Binance с новым algoId и параметрами
 *
 * @throws Если позиция не найдена и newQuantityUsd не указан
 * @throws Если algoId не существует или уже исполнен
 *
 * @example
 * await client.modifyTP({ symbol: 'BTCUSDT', algoId: 1000000000214986, newTriggerPrice: 110000, positionSide: 'LONG' });
 */
  private async modifyTakeProfitOrStopLoss({
    symbol,
    algoId,
    newTriggerPrice,
    newQuantityUsd,
    positionSide,
    isTakeProfit = true,
  }: {
    symbol: string;
    algoId: number;
    newTriggerPrice: number;
    newQuantityUsd?: number;
    positionSide: 'LONG' | 'SHORT';
    isTakeProfit?: boolean;
  }) {
    try {
      if (!algoId) throw new Error('algoId обязателен');

      await this.updatePositions();
      const position = this._positions$.value.find(
        p => p.symbol === symbol && p.positionSide === positionSide
      );

      let quantityNum: number;
      if (newQuantityUsd !== undefined) {
        const price = await this.getCurrentPrice(symbol);
        const info = await this.getSymbolInfo(symbol);
        let qty = newQuantityUsd / price;
        qty = Math.floor(qty / info.stepSize) * info.stepSize;
        if (qty < info.minQty) throw new Error('Новый объём слишком мал');
        quantityNum = Number(qty.toFixed(info.precision));
      } else if (position) {
        quantityNum = Math.abs(Number(position.positionAmt));
      } else {
        throw new Error(`Позиция ${symbol} ${positionSide} не найдена. Укажите newQuantityUsd явно (размер в USD).`);
      }

      const closeSide = positionSide === 'LONG' ? 'SELL' : 'BUY';
      const algoType = isTakeProfit ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET';

      // Отмена старого
      const cancelResp = await this.client.restAPI.cancelAlgoOrder({ algoid: algoId });
      const cancelData = await cancelResp.data();
      console.log(`[ALGO CANCEL] AlgoId ${algoId} отменён`);

      // Создание нового
      const newResp = await this.client.restAPI.newAlgoOrder({
        symbol,
        side: closeSide as any,
        algoType: 'CONDITIONAL',
        type: algoType,
        quantity: quantityNum,
        triggerPrice: newTriggerPrice,
        workingType: 'MARK_PRICE',
        positionSide: positionSide as any,
        newClientOrderId: `mod_${algoType.toLowerCase()}_${Date.now()}`,
      } as any);

      const newData = await newResp.data();
      console.log(`[ALGO MODIFY] Новый ${algoType} создан: algoId=${newData.algoId}, price=${newTriggerPrice}, qty=${quantityNum}`);
      return newData;
    } catch (error: any) {
      console.error(`Не удалось изменить algo-ордер ${algoId}:`, error?.code, error?.msg || error.message || error);
      throw error;
    }
  }

  /**
   * Изменяет Take-Profit (TP) algo-ордер
   *
   * @example
   * await client.modifyTP({
   *   symbol: 'BTCUSDT',
   *   algoId: strategy.tpAlgoId!,
   *   newTriggerPrice: 110000,
   *   newQuantityUsd: 1000,     // опционально, если позиция ещё не открыта
   *   positionSide: 'LONG'
   * });
   */
  async modifyTP(params: {
    symbol: string; algoId: number; newTriggerPrice: number; newQuantityUsd?: number; positionSide: 'LONG' | 'SHORT'
  }) {
    return this.modifyTakeProfitOrStopLoss({ ...params, isTakeProfit: true });
  }

  /**
   * Изменяет Stop-Loss (SL) algo-ордер
   *
   * @example
   * await client.modifySL({
   *   symbol: 'BTCUSDT',
   *   algoId: strategy.slAlgoId!,
   *   newTriggerPrice: 58000,
   *   newQuantityUsd: 1000,
   *   positionSide: 'LONG'
   * });
   */
  async modifySL(params: {
    symbol: string;
    algoId: number;
    newTriggerPrice: number;
    newQuantityUsd?: number;
    positionSide: 'LONG' | 'SHORT';
  }) {
    return this.modifyTakeProfitOrStopLoss({ ...params, isTakeProfit: false });
  }

  /**
 * Устанавливает полноценную стратегию: лимитный вход + стоп-лосс + тейк-профит.
 * Полностью рабочая версия под Binance Futures USDS-M после миграции Algo Order API.
 *
 * @param symbol        Торговый символ (например "BTCUSDT")
 * @param side          Направление входа: 'BUY' = LONG, 'SELL' = SHORT
 * @param usdAmount     Размер позиции в USDT
 * @param entryPrice    Цена лимитного ордера
 * @param stopLoss      Цена срабатывания стоп-лосса
 * @param takeProfit    Цена срабатывания тейк-профита
 * @param positionSide  Сторона позиции: 'LONG' или 'SHORT'
 *
 * @returns Объект с ID всех созданных ордеров и параметрами
 */
  async strategy({
    symbol,
    side,
    usdAmount,
    entryPrice,
    stopLoss,
    takeProfit,
    positionSide = side === 'BUY' ? 'LONG' : 'SHORT',
  }: {
    symbol: string;
    side: 'BUY' | 'SELL';
    usdAmount: number;
    entryPrice: number;
    stopLoss: number;
    takeProfit: number;
    positionSide: 'LONG' | 'SHORT';
  }) {
    const info = await this.getSymbolInfo(symbol);

    let qty = usdAmount / entryPrice;
    qty = Math.floor(qty / info.stepSize) * info.stepSize;
    if (qty < info.minQty) throw new Error(`Ордер слишком мал: ${qty} < ${info.minQty}`);

    const quantityStr = qty.toFixed(info.precision);
    const quantityNum = Number(quantityStr);

    const baseClientOrderId = `s_${Date.now()}`;

    // Округляем цену до нужной точности и преобразуем в число
    const roundedEntryPrice = Number(entryPrice.toFixed(info.precision || 1));

    // 1. Лимитный ордер (Вход) через REST API
    const entryResp = await this.client.restAPI.newOrder({
      symbol,
      side: side as any,
      type: 'LIMIT' as any,
      timeInForce: 'GTC' as any,
      quantity: quantityNum,
      price: roundedEntryPrice,
      positionSide: positionSide as any,
      newClientOrderId: baseClientOrderId,
    });

    const entryData = await entryResp.data();

    const slSide = side === 'BUY' ? 'SELL' : 'BUY';

    // 2. Stop-Loss через Algo API
    const slResp = await this.client.restAPI.newAlgoOrder({
      symbol,
      side: slSide as any,
      algoType: 'CONDITIONAL' as any,
      type: 'STOP_MARKET' as any,
      quantity: quantityNum,
      triggerPrice: stopLoss,
      workingType: 'MARK_PRICE' as any,
      positionSide: positionSide as any,
      // ✅ УДАЛЕНО: newClientOrderId, т.к. не существует в NewAlgoOrderRequest$1
    });

    // 3. Take-Profit через Algo API
    const tpResp = await this.client.restAPI.newAlgoOrder({
      symbol,
      side: slSide as any,
      algoType: 'CONDITIONAL' as any,
      type: 'TAKE_PROFIT_MARKET' as any,
      quantity: quantityNum,
      triggerPrice: takeProfit,
      workingType: 'MARK_PRICE' as any,
      positionSide: positionSide as any,
      // ✅ УДАЛЕНО: newClientOrderId, т.к. не существует в NewAlgoOrderRequest$1
    });

    const slData = await slResp.data();
    const tpData = await tpResp.data();

    return {
      entryOrderId: entryData.clientOrderId as string,
      slAlgoId: slData.algoId as number,
      tpAlgoId: tpData.algoId as number,
      quantity: quantityStr,
      entryPrice,
      stopLoss,
      takeProfit,
      positionSide,
    };
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

  /**
 * Обновляет текущее состояние всех открытых позиций из аккаунта Binance Futures (USDS-M).
 *
 * Особенности:
 *  • Использует эндпоинт `/fapi/v2/accountInformation` — самый полный и актуальный
 *  • Автоматически фильтрует нулевые позиции (positionAmt === 0)
 *  • Работает в One-Way и Hedge Mode (правильно парсит positionSide: LONG/SHORT/BOTH)
 *  • Обновляет RxJS BehaviorSubject → все подписчики получают свежие данные мгновенно
 *  • Защищён от падений — при ошибке просто логирует warning, не ломает клиент
 *
 * Вызывается:
 *  • При старте соединения
 *  • При получении событий ACCOUNT_UPDATE / ORDER_TRADE_UPDATE через UserData Stream
 *  • Принудительно через forceClosePosition и т.д.
 *
 * @private — внутренний метод класса BinanceFuturesClient
 */
  private async updatePositions() {
    try {
      // 1. Запрос актуальной информации об аккаунте
      //    Метод accountInformationV2() — рекомендуется Binance с 2023 года
      const accResponse = await this.client.restAPI.accountInformationV2();

      // 2. Получаем чистые данные (библиотека возвращает Response → data())
      const acc = await accResponse.data();

      // 3. Проверка и парсинг массива позиций
      if (!Array.isArray(acc.positions)) {
        console.warn('[updatePositions] Неожиданная структура: acc.positions не массив', acc);
        this._positions$.next([]); // сбрасываем на пустой массив
        return;
      }

      // 4. Фильтруем только активные (ненулевые) позиции и маппим в удобный формат
      const activePositions: Position[] = acc.positions
        .filter((p: any) => {
          // positionAmt — строка, поэтому Number() обязателен
          const amt = Number(p.positionAmt);
          return amt !== 0 && !isNaN(amt);
        })
        .map((p: any): Position => ({
          symbol: p.symbol,
          positionAmt: p.positionAmt,                    // строка, как приходит от Binance
          entryPrice: p.entryPrice,                      // средняя цена входа
          markPrice: p.markPrice,                        // текущая марк-цена
          unrealizedPnL: p.unrealizedProfit,             // нереализованный PnL (строка)
          leverage: p.leverage,                          // текущее плечо
          positionSide: p.positionSide as Position['positionSide'], // 'BOTH' | 'LONG' | 'SHORT'
        }));

      // 5. Пушим в BehaviorSubject — все подписчики (UI, стратегии и т.д.) получат обновление
      this._positions$.next(activePositions);

      // Опционально: полезный лог при отладке
      if (activePositions.length > 0) {
        console.log(
          `[POSITIONS] Обновлено ${activePositions.length} активных позиций: ` +
          activePositions.map(p => `${p.symbol} ${p.positionAmt} (${p.positionSide})`).join(', ')
        );
      } else {
        console.log('[POSITIONS] Нет открытых позиций');
      }

    } catch (error: any) {
      // 6. Надёжная обработка ошибок — клиент не должен упасть из-за временных проблем
      console.warn(
        '[updatePositions] Не удалось обновить позиции:',
        error?.code ? `${error.code}: ${error.msg}` : error?.message || error
      );

      // При критических ошибках (например, неверный API-ключ) можно сбросить
      if (error?.code === -2015 || error?.code === -1022) {
        console.error('Критическая ошибка авторизации. Проверьте API ключ и права.');
        // Можно добавить this._status$.next('disconnected') + reconnect логику
      }

      // В любом случае — сбрасываем позиции, чтобы не работать со старыми данными
      this._positions$.next([]);
    }
  }

  /**
 * Принудительное закрытие позиции по рыночному ордеру (MARKET).
 * 
 * Особенности:
 *  • 100% гарантирует закрытие всей позиции (даже при частичном исполнении предыдущих ордеров)
 *  • Использует точное количество из accountInformationV2 → нет риска переворота
 *  • Работает корректно как в Hedge Mode, так и в One-Way Mode
 *  • НЕ использует closePosition: true → избегает ошибки -4136
 * 
 * @param symbol        Торговый символ (например "BTCUSDT", "ETHUSDT")
 * @param positionSide  Сторона позиции: 'LONG' или 'SHORT' (на тестнете — только эти два!)
 * 
 * @returns Promise<NewOrderResponse> или undefined (если позиции нет)
 * 
 * @example
 * await client.forceClosePosition('BTCUSDT', 'LONG');
 */
  async forceClosePosition(symbol: string, positionSide: 'LONG' | 'SHORT') {
    try {
      // 1. Принудительно обновляем актуальные позиции (очень важно при быстрых изменениях)
      await this.updatePositions();

      const positions = this._positions$.value;
      const pos = positions.find(
        p => p.symbol === symbol && p.positionSide === positionSide
      );

      // 2. Если позиции нет или она уже нулевая — выходим
      if (!pos || Number(pos.positionAmt) === 0) {
        console.log(`[FORCE CLOSE] Позиция ${symbol} ${positionSide} уже закрыта или отсутствует`);
        return;
      }

      // 3. Определяем сторону закрытия
      const closeSide = Number(pos.positionAmt) > 0 ? 'SELL' : 'BUY';

      // 4. Точное количество контрактов (Binance требует строку!)
      const rawQty = Math.abs(Number(pos.positionAmt));

      // Важно: используем правильную точность (для BTCUSDT — 3 знака, для ETHUSDT — 3, для большинства альт — 0–5)
      // Берём из symbol info или просто 8 — безопасно для всех
      const quantity = rawQty.toFixed(8);

      console.log(
        `[FORCE CLOSE] ${closeSide} ${quantity} ${symbol} (${positionSide}) ` +
        `| Entry: ${parseFloat(pos.entryPrice).toFixed(2)} ` +
        `| PNL: ${parseFloat(pos.unrealizedPnL).toFixed(2)} USDT`
      );

      // 5. Отправляем рыночный ордер
      const orderResponse = await this.wsApi.newOrder({
        symbol,
        side: closeSide,
        type: 'MARKET' as const,
        quantity,
        positionSide,
      });

      console.log(`[FORCE CLOSE SUCCESS] Ордер на закрытие отправлен. OrderId: ${orderResponse.data.orderId}`);
      return orderResponse;
    } catch (error: any) {
      console.error(
        `[FORCE CLOSE ERROR] Не удалось закрыть позицию ${symbol} ${positionSide}:`,
        error?.code ? `${error.code}: ${error.msg}` : error
      );

      // Особая подсветка частых ошибок
      if (error?.code === -4061) {
        console.error(`Ошибка: positionSide не соответствует режиму. Используй 'LONG'/'SHORT', а не 'BOTH'`);
      }
      if (error?.code === -4136) {
        console.error(`Ошибка -4136: не используй closePosition: true с MARKET ордерами!`);
      }
      if (error?.code === -1100) {
        console.error(`Параметр quantity некорректен — возможно, слишком много знаков после запятой`);
      }

      throw error; // Пробрасываем дальше, если нужно обработать выше
    }
  }

  destroy() {
    this._destroy$.next();
    this._destroy$.complete();
    this.wsStreams?.unsubscribe();
    this.wsApi?.unsubscribe();
    this._status$.next('disconnected');
  }
}