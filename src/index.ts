// src/index.ts

import { BinanceFuturesClient, Candle } from './BinanceClient';
import { filter } from 'rxjs/operators';

import 'dotenv/config';

// --- Конфигурация ---
// ВАЖНО: Замените эти значения на ваши реальные ключи!
const API_KEY = process.env.BINANCE_API_KEY!;
const API_SECRET = process.env.BINANCE_API_SECRET!;
const USE_TESTNET = true; // Установите в false для реальной торговли
const SYMBOL = 'BTCUSDT';
const LEVERAGE = 10;
const USD_AMOUNT = 2000; // Сумма в USD для тестового ордера (должна быть больше минимального лимита)
// --------------------

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function startTradingClient() {
  if (!API_KEY) {
    console.error('❌ ERROR: Пожалуйста, замените API_KEY и API_SECRET в src/index.ts или используйте переменные окружения.');
    return;
  }

  console.log(`🚀 Запуск клиента Binance Futures (Testnet: ${USE_TESTNET})`);

  const client = new BinanceFuturesClient(API_KEY, API_SECRET);

  // ——————————— 1. Подписки на потоки данных (RxJS) ———————————

  // Подписка на изменение статуса соединения
  client.status$.subscribe(status => {
    console.log(`[STATUS] => ${status.toUpperCase()}`);
    if (status === 'disconnected') {
      console.log('Потеря соединения. Попытка переподключения...');
    }
  });

  // Подписка на новые 1-минутные свечи
  // client.candles$
  //   .pipe(filter((c: Candle | null): c is Candle => c !== null))
  //   .subscribe(candle => {
  //     // Свеча считается "закрытой", если k.x === true, но мы здесь смотрим на T (closeTime)
  //     if (candle.closeTime % 60000 === 0) { // Простой способ проверить, что свеча закрыта (T кратно минуте)
  //       console.log(`[CANDLE] ${SYMBOL} | O:${candle.open} H:${candle.high} L:${candle.low} C:${candle.close} | Время: ${new Date(candle.openTime).toLocaleTimeString()}`);
  //     }
  //   });

  // Подписка на изменение позиций
  // client.positions$.subscribe(positions => {
  //   if (positions.length > 0) {
  //     console.log(`\n[POSITIONS] Обновление (${positions.length} активных позиций):`);
  //     positions.forEach(p => {
  //       console.log(`  - ${p.symbol}: ${p.positionAmt} (PNL: ${parseFloat(p.unrealizedPnL).toFixed(2)}) @ ${p.entryPrice}`);
  //     });
  //     console.log('--------------------');
  //   } else {
  //     console.log('[POSITIONS] Нет активных позиций.');
  //   }
  // });


  // ——————————— 2. Установление соединения и выполнение команд ———————————
  try {
    // Начать подключение к потокам (REST API, WS Streams, WS API)
    await client.connect(SYMBOL, '1m');

    // Ждем установки соединения
    await sleep(5000);

    if (client.statusValue !== 'connected') {
      console.error('🛑 Не удалось установить соединение. Проверьте ключи и права доступа.');
      return;
    }

    // 1. Настройка режима (Если не хотите хеджировать, пропустите)
    //await client.enableHedgeMode(); 
    // console.log(`[CONFIG] Режим хеджирования включен.`);

    // 2. Установка плеча
    // await client.setLeverage(SYMBOL, LEVERAGE);
    // console.log(`[CONFIG] Установлено плечо ${LEVERAGE}x для ${SYMBOL}.`);

    // 3. Получение исторических данных
    // const klines = await client.getKlines(SYMBOL, '1h', 5);
    // console.log(`\n[REST] Получены последние 5 свечей ${SYMBOL} (1h):`);
    // klines.forEach(k => console.log(`  - ${new Date(k.openTime).toLocaleDateString()}: ${k.close}`));


    // 4. Размещение рыночного ордера
    // console.log(`\n[TRADE] Размещение ордера LONG на ${USD_AMOUNT} USD...`);

    // const orderResult = await client.marketOrder({
    //   symbol: SYMBOL,
    //   side: 'BUY',
    //   usdAmount: USD_AMOUNT,
    //   positionSide: 'LONG',
    // });

    // await sleep(10000);
    // console.log(`\n[TRADE] Закрытие позиции ${SYMBOL}...`);
    // await client.forceClosePosition(SYMBOL, 'LONG');

    const price = 95000;
    await client.limitOrder({
      symbol: 'BTCUSDT',
      side: 'SELL',
      usdAmount: 800,
      price,
      positionSide: 'SHORT',
    });
    // Лонг от 60к с выходом по 61.5к и стопом на 59.5к
    await client.limitOrderStrategy({
      symbol: 'BTCUSDT',
      side: 'BUY',
      usdAmount: 1000,
      entryPrice: 60000,
      stopLoss: 59500,
      takeProfit: 105000,
      positionSide: 'LONG',  // ← обязательно на тестнете!
    });

    // Шорт от текущей цены -3%
    await client.limitOrderStrategy({
      symbol: 'BTCUSDT',
      side: 'SELL',
      usdAmount: 800,
      entryPrice: 110000,
      stopLoss: 115000,
      takeProfit: 80000,
      positionSide: 'SHORT',
    });

  } catch (error) {
    console.error('❌ ПРОИЗОШЛА КРИТИЧЕСКАЯ ОШИБКА В РАБОТЕ КЛИЕНТА:', error);
  } finally {
    // В реальной работе destroy не вызывается, но для тестового скрипта это важно
    console.log('\n[INFO] Остановка клиента через 5 секунд...');
    await sleep(5000);
    client.destroy();
  }
}

startTradingClient();