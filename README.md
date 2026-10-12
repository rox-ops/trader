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

To submit real orders, set `TRADING_MODE=live` only after testing with paper mode and configuring credentials. Live mode is intentionally not enabled by default. Review FYERS order parameters and your broker permissions before enabling it.

## Scope and safety

This is an engineering starter, not financial advice. AI outputs are untrusted signals: the service applies a confidence threshold, records decisions and orders in SQLite, and exposes start/stop controls. Add authentication, position limits, a kill switch, idempotency, market-hours checks, and independent risk approval before any unattended live deployment.