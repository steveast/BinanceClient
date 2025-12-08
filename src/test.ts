// test-exchange.ts
import { DerivativesTradingUsdsFutures } from '@binance/derivatives-trading-usds-futures';
import 'dotenv/config';

const client = new DerivativesTradingUsdsFutures({
  configurationRestAPI: {
    apiKey: process.env.BINANCE_API_KEY!,
    apiSecret: process.env.BINANCE_API_SECRET!,
    basePath: 'https://testnet.binancefuture.com', // без /fapi/v1
  },
});

async function test() {
  try {
    console.log('Делаем запрос exchangeInformation()...');

    // ← Правильно: без параметров
    const response = await client.restAPI.exchangeInformation();

    // ← КРИТИЧНО: .data() — это Promise! Нужен await!
    const data = await response.data();

    console.log(data);
  } catch (err: any) {
    console.error('ОШИБКА:');
    console.error('  message:', err.message);
    if (err.response?.data) {
      console.error('  binance error:', err.response.data);
    }
  }
}

test();