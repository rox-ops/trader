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
  symbols: (process.env.BOT_SYMBOLS || 'NSE:SBIN-EQ,NSE:RELIANCE-EQ').split(',').map((s) => s.trim()).filter(Boolean),
  provider: process.env.AI_PROVIDER || 'mock',
  apiKey: process.env.AI_API_KEY || '',
  baseUrl: process.env.AI_BASE_URL || 'https://api.openai.com/v1',
  model: process.env.AI_MODEL || 'gpt-4o-mini',
  minConfidence: Number(process.env.AI_MIN_CONFIDENCE || 0.7),
  pollSeconds: Number(process.env.BOT_POLL_SECONDS || 60),
  clientId: process.env.FYERS_CLIENT_ID || '',
  accessToken: process.env.FYERS_ACCESS_TOKEN || ''
};
const db = new Database(process.env.DATABASE_FILE || 'trader.db');
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS trades (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, side TEXT NOT NULL, quantity INTEGER NOT NULL, price REAL NOT NULL, status TEXT NOT NULL, broker_order_id TEXT, source TEXT NOT NULL, reason TEXT NOT NULL, confidence REAL NOT NULL, created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, event_type TEXT NOT NULL, message TEXT NOT NULL, symbol TEXT, created_at TEXT NOT NULL);`);
const state = { running: false, lastCycle: null };
const now = () => new Date().toISOString();
const addEvent = (eventType, message, level = 'info', symbol = null) => db.prepare('INSERT INTO events (level,event_type,message,symbol,created_at) VALUES (?,?,?,?,?)').run(level, eventType, message, symbol, now());

async function quote(symbol) {
  if (!settings.clientId || !settings.accessToken) return { symbol, ltp: 100, source: 'demo' };
  const response = await fetch(`https://api-t1.fyers.in/api/v3/quotes?symbols=${encodeURIComponent(symbol)}`, { headers: { Authorization: `${settings.clientId}:${settings.accessToken}` } });
  if (!response.ok) throw new Error(`FYERS quote failed (${response.status})`);
  const data = await response.json();
  return { symbol, ltp: Number(data.d?.[0]?.v?.lp || 0), source: 'fyers' };
}

async function history(symbol) {
  const candleCount = 120;
  if (!settings.clientId || !settings.accessToken) {
    return Array.from({ length: candleCount }, (_, index) => ({ close: 100 + Math.sin(index / 8) * 2 + index * 0.01 }));
  }
  const to = Math.floor(Date.now() / 1000);
  const from = to - (candleCount * 15 * 60);
  const params = new URLSearchParams({ symbol, resolution: '15', date_format: '0', range_from: String(from), range_to: String(to), cont_flag: '1' });
  const response = await fetch(`https://api-t1.fyers.in/data/history?${params}`, { headers: { Authorization: `${settings.clientId}:${settings.accessToken}` } });
  if (!response.ok) throw new Error(`FYERS history failed (${response.status})`);
  const data = await response.json();
  return (data.candles || []).map((candle) => ({ timestamp: candle[0], open: candle[1], high: candle[2], low: candle[3], close: candle[4], volume: candle[5] }));
}

async function decide(symbol, marketQuote, indicators) {
  if (settings.provider === 'mock' || !settings.apiKey) return { action: 'HOLD', quantity: 0, confidence: 0.99, reason: 'Demo mode: no position opened' };
  const response = await fetch(`${settings.baseUrl.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: settings.model, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'You are a cautious trading signal classifier. Return JSON only. Never claim certainty. Treat indicators as informational, not guarantees.' }, { role: 'user', content: `Return action BUY, SELL, or HOLD; quantity integer; confidence 0..1; reason string. Symbol=${symbol}, quote=${JSON.stringify(marketQuote)}, technical_indicators=${JSON.stringify(indicators)}` }] }) });
  if (!response.ok) throw new Error(`AI provider failed (${response.status})`);
  return JSON.parse((await response.json()).choices[0].message.content);
}

async function placeOrder(symbol, side, quantity) {
  if (!settings.clientId || !settings.accessToken) throw new Error('FYERS credentials are not configured');
  const response = await fetch('https://api-t1.fyers.in/api/v3/orders/sync', { method: 'POST', headers: { Authorization: `${settings.clientId}:${settings.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol, qty: quantity, type: 2, side: side === 'BUY' ? 1 : -1, productType: 'INTRADAY', limitPrice: 0, stopPrice: 0, validity: 'DAY', offlineOrder: false }) });
  if (!response.ok) throw new Error(`FYERS order failed (${response.status})`);
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
      if (settings.mode === 'live') { const result = await placeOrder(symbol, action, quantity); orderId = String(result.id || result.orderId || 'unknown'); status = 'submitted'; source = 'fyers'; }
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
