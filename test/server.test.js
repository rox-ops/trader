import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PORT = '8123';
process.env.MARKET_DATA_MODE = 'demo';
const { app, db, state } = await import('../server.js');
const { calculateIndicators } = await import('../technicalIndicators.js');
const server = app.listen(8123);

const get = (path) => fetch(`http://127.0.0.1:8123${path}`);

test('status starts in paper mode', async () => {
  const response = await get('/api/status');
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.mode, 'paper');
});

test('bot control toggles state', async () => {
  const response = await fetch('http://127.0.0.1:8123/api/bot/start', { method: 'POST' });
  assert.equal((await response.json()).running, true);
  state.running = false;
});

test('calculates technical indicators from candle closes', () => {
  const candles = Array.from({ length: 40 }, (_, index) => ({ close: 100 + index }));
  const indicators = calculateIndicators(candles);
  assert.equal(indicators.candles, 40);
  assert.equal(indicators.sma20, 129.5);
  assert.equal(indicators.trend, 'BULLISH');
  assert.equal(indicators.rsi14, 100);
  assert.ok(indicators.macd > 0);
});

test('exposes calculated indicators through the market endpoint', async () => {
  const response = await get('/api/market/NSE%3ASBIN-EQ/indicators');
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.source, 'demo');
  assert.equal(body.indicators.candles, 120);
  assert.ok(body.indicators.rsi14 !== null);
});

test.after(() => { server.close(); db.close(); });
