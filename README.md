# SignalDesk AI Trader

An AI-assisted trading dashboard for FYERS with a paper-trading-first execution loop.

## Run locally (JavaScript)

```bash
npm install
cp .env.example .env
npm run dev
```

Open http://127.0.0.1:8000. The dashboard starts in `TRADING_MODE=paper`; the demo AI provider returns `HOLD`, so it will not create positions by default. Records are stored in `trader.db` (SQLite).

## Configuration

Set `FYERS_CLIENT_ID` and `FYERS_ACCESS_TOKEN` for FYERS quotes. Set `AI_PROVIDER` and `AI_API_KEY` to use an OpenAI-compatible provider (OpenAI, compatible gateways, or a self-hosted endpoint). The adapter uses `AI_BASE_URL` and `AI_MODEL` so provider choice is configuration, not a code change.

Technical indicators are calculated locally from FYERS historical candles. Each cycle fetches 15-minute candles and derives SMA 20, EMA 12/26, RSI 14, MACD, and a simple EMA trend label. No broker-provided indicator endpoint is required; the raw candle response is the source of truth.

The calculated snapshot is also available at `GET /api/market/NSE%3ASBIN-EQ/indicators`. For production, use FYERS credentials; without them the endpoint uses deterministic demo candles for development only.

To submit real orders, set `TRADING_MODE=live` only after testing with paper mode and configuring credentials. Live mode is intentionally not enabled by default. Review FYERS order parameters and your broker permissions before enabling it.

## Scope and safety

This is an engineering starter, not financial advice. AI outputs are untrusted signals: the service applies a confidence threshold, records decisions and orders in SQLite, and exposes start/stop controls. Add authentication, position limits, a kill switch, idempotency, market-hours checks, and independent risk approval before any unattended live deployment.