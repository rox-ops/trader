import 'dotenv/config';
import express from 'express';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { calculateIndicators } from './technicalIndicators.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 8000);
const settings = {
  mode: process.env.TRADING_MODE || 'paper',
  symbols: (process.env.BOT_SYMBOLS || 'SBIN.NS,RELIANCE.NS').split(',').map((s) => s.trim()).filter(Boolean),
  provider: process.env.AI_PROVIDER || 'mock',
  marketDataMode: process.env.MARKET_DATA_MODE || 'yahoo',
  apiKey: process.env.AI_API_KEY || '',
  baseUrl: process.env.AI_BASE_URL || 'https://api.openai.com/v1',
  model: process.env.AI_MODEL || 'gpt-4o-mini',
  minConfidence: Number(process.env.AI_MIN_CONFIDENCE || 0.7),
  pollSeconds: Number(process.env.BOT_POLL_SECONDS || 60),
  dhanClientId: process.env.DHAN_CLIENT_ID || '',
  dhanAccessToken: process.env.DHAN_ACCESS_TOKEN || '',
  dhanBaseUrl: process.env.DHAN_BASE_URL || 'https://api.dhan.co/v2',
  dhanExchangeSegment: process.env.DHAN_EXCHANGE_SEGMENT || 'NSE_EQ',
  dhanProductType: process.env.DHAN_PRODUCT_TYPE || 'INTRADAY',
  dhanSecurityIds: JSON.parse(process.env.DHAN_SECURITY_IDS || '{}')
};
const db = new Database(process.env.DATABASE_FILE || 'trader.db');
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS trades (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, side TEXT NOT NULL, quantity INTEGER NOT NULL, price REAL NOT NULL, status TEXT NOT NULL, broker_order_id TEXT, source TEXT NOT NULL, reason TEXT NOT NULL, confidence REAL NOT NULL, created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, event_type TEXT NOT NULL, message TEXT NOT NULL, symbol TEXT, created_at TEXT NOT NULL);`);
const state = { running: false, lastCycle: null };
const now = () => new Date().toISOString();
const addEvent = (eventType, message, level = 'info', symbol = null) => db.prepare('INSERT INTO events (level,event_type,message,symbol,created_at) VALUES (?,?,?,?,?)').run(level, eventType, message, symbol, now());

async function quote(symbol) {
  if (settings.marketDataMode === 'demo') return { symbol, ltp: 100, source: 'demo' };
  const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=15m&range=1d`, { headers: { 'User-Agent': 'SignalDesk/1.0' } });
  if (!response.ok) throw new Error(`Yahoo quote failed (${response.status})`);
  const data = await response.json();
  const meta = data.chart?.result?.[0]?.meta;
  return { symbol, ltp: Number(meta?.regularMarketPrice || meta?.previousClose || 0), source: 'yahoo' };
}

async function history(symbol) {
  const candleCount = 120;
  if (settings.marketDataMode === 'demo') return Array.from({ length: candleCount }, (_, index) => ({ close: 100 + Math.sin(index / 8) * 2 + index * 0.01 }));
  const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=15m&range=5d`, { headers: { 'User-Agent': 'SignalDesk/1.0' } });
  if (!response.ok) throw new Error(`Yahoo history failed (${response.status})`);
  const data = await response.json();
  const result = data.chart?.result?.[0];
  const quoteData = result?.indicators?.quote?.[0] || {};
  return (result?.timestamp || []).map((timestamp, index) => ({ timestamp, open: quoteData.open?.[index], high: quoteData.high?.[index], low: quoteData.low?.[index], close: quoteData.close?.[index], volume: quoteData.volume?.[index] })).filter((candle) => Number.isFinite(candle.close)).slice(-candleCount);
}

async function decide(symbol, marketQuote, indicators) {
  if (settings.provider === 'mock' || !settings.apiKey) return { action: 'HOLD', quantity: 0, confidence: 0.99, reason: 'Demo mode: no position opened' };
  const response = await fetch(`${settings.baseUrl.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: settings.model, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'You are a cautious trading signal classifier. Return JSON only. Never claim certainty. Treat indicators as informational, not guarantees.' }, { role: 'user', content: `Return action BUY, SELL, or HOLD; quantity integer; confidence 0..1; reason string. Symbol=${symbol}, quote=${JSON.stringify(marketQuote)}, technical_indicators=${JSON.stringify(indicators)}` }] }) });
  if (!response.ok) throw new Error(`AI provider failed (${response.status})`);
  return JSON.parse((await response.json()).choices[0].message.content);
}

async function placeOrder(symbol, side, quantity) {
  if (!settings.dhanClientId || !settings.dhanAccessToken) throw new Error('Dhan credentials are not configured');
  const securityId = settings.dhanSecurityIds[symbol];
  if (!securityId) throw new Error(`No Dhan securityId mapping configured for ${symbol}`);
  const response = await fetch(`${settings.dhanBaseUrl}/orders`, { method: 'POST', headers: { 'access-token': settings.dhanAccessToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ dhanClientId: settings.dhanClientId, correlationId: `signaldesk-${Date.now()}`.slice(0, 30), transactionType: side, exchangeSegment: settings.dhanExchangeSegment, productType: settings.dhanProductType, orderType: 'MARKET', validity: 'DAY', securityId: String(securityId), quantity, price: 0, afterMarketOrder: false }) });
  if (!response.ok) throw new Error(`Dhan order failed (${response.status}): ${await response.text()}`);
  return response.json();
}

async function runCycle() {
  for (const symbol of settings.symbols) {
    try {
      const marketQuote = await quote(symbol);
      const candles = await history(symbol);
      const indicators = calculateIndicators(candles);
      const decision = await decide(symbol, marketQuote, indicators);
      const action = String(decision.action || 'HOLD').toUpperCase();
      const confidence = Number(decision.confidence || 0);
      const quantity = Number.parseInt(decision.quantity || 0, 10);
      addEvent('decision', `${action} signal at ${(confidence * 100).toFixed(0)}%: ${decision.reason || ''} | RSI ${indicators.rsi14?.toFixed(1) ?? 'n/a'} | ${indicators.trend}`, 'info', symbol);
      if (!['BUY', 'SELL'].includes(action) || quantity <= 0 || confidence < settings.minConfidence) continue;
      let orderId = `paper-${randomUUID()}`; let status = 'simulated'; let source = 'paper';
      if (settings.mode === 'live') { const result = await placeOrder(symbol, action, quantity); orderId = String(result.id || result.orderId || 'unknown'); status = 'submitted'; source = 'dhan'; }
      db.prepare('INSERT INTO trades (symbol,side,quantity,price,status,broker_order_id,source,reason,confidence,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(symbol, action, quantity, marketQuote.ltp, status, orderId, source, String(decision.reason || ''), confidence, now());
      addEvent('order', `${source} ${action} ${quantity} @ ${marketQuote.ltp}`, 'info', symbol);
    } catch (error) { addEvent('error', error.message, 'error', symbol); }
  }
  state.lastCycle = now();
}

app.use(express.json());
app.use('/static', express.static(path.join(__dirname, 'app/static')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'app/static/index.html')));
app.get('/api/status', (_req, res) => res.json({ running: state.running, mode: settings.mode, provider: settings.provider, symbols: settings.symbols, last_cycle: state.lastCycle }));
app.post('/api/bot/:action', (req, res) => { if (!['start', 'stop'].includes(req.params.action)) return res.status(400).json({ error: 'action must be start or stop' }); state.running = req.params.action === 'start'; addEvent('bot', `Bot ${req.params.action}ed`); res.json({ running: state.running, mode: settings.mode, provider: settings.provider, symbols: settings.symbols, last_cycle: state.lastCycle }); });
app.post('/api/cycle', async (_req, res) => { await runCycle(); res.json({ ok: true }); });
app.get('/api/market/:symbol/indicators', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const [marketQuote, candles] = await Promise.all([quote(symbol), history(symbol)]);
    res.json({ symbol, quote: marketQuote, indicators: calculateIndicators(candles), source: marketQuote.source });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});
app.get('/api/trades', (_req, res) => res.json(db.prepare('SELECT * FROM trades ORDER BY created_at DESC LIMIT 50').all()));
app.get('/api/events', (_req, res) => res.json(db.prepare('SELECT * FROM events ORDER BY created_at DESC LIMIT 100').all()));

const isMainProcess = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
const server = isMainProcess ? app.listen(port, () => console.log(`SignalDesk listening on http://127.0.0.1:${port}`)) : null;
const loop = isMainProcess ? setInterval(() => { if (state.running) runCycle().catch((error) => addEvent('error', error.message, 'error')); }, settings.pollSeconds * 1000) : null;
const shutdown = () => { if (loop) clearInterval(loop); if (server) server.close(() => db.close()); else db.close(); };
if (isMainProcess) { process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown); }
export { app, db, state };
