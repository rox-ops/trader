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

Set `DHAN_CLIENT_ID`, `DHAN_ACCESS_TOKEN`, and `DHAN_SECURITY_IDS` to enable Dhan order execution. Set `AI_PROVIDER` and `AI_API_KEY` to use an OpenAI-compatible provider (OpenAI, compatible gateways, or a self-hosted endpoint). The adapter uses `AI_BASE_URL` and `AI_MODEL` so provider choice is configuration, not a code change.

`DHAN_SECURITY_IDS` must map each Yahoo ticker to the correct Dhan `securityId`, for example `{"RELIANCE.NS":"<dhan-security-id>"}`. Do not guess these IDs; download Dhan's instrument master and resolve them before enabling live mode.

Yahoo Finance supplies the market data and 15-minute candles by default. Technical indicators are calculated locally from those candles. Each cycle derives SMA 20, EMA 12/26, RSI 14, MACD, and a simple EMA trend label. Dhan is used only for order execution.

The calculated snapshot is also available at `GET /api/market/NSE%3ASBIN-EQ/indicators`. For production, use FYERS credentials; without them the endpoint uses deterministic demo candles for development only.

To submit real orders, set `TRADING_MODE=live` only after testing with paper mode and configuring Dhan credentials. Dhan order APIs require static IP whitelisting, and the access token must be valid. Live mode is intentionally not enabled by default.

## Scope and safety

This is an engineering starter, not financial advice. AI outputs are untrusted signals: the service applies a confidence threshold, records decisions and orders in SQLite, and exposes start/stop controls. Add authentication, position limits, a kill switch, idempotency, market-hours checks, and independent risk approval before any unattended live deployment.