function sma(values, period) {
  if (values.length < period) return null;
  return values.slice(-period).reduce((sum, value) => sum + value, 0) / period;
}

function ema(values, period) {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let result = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (const value of values.slice(period)) result = (value - result) * multiplier + result;
  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  const changes = values.slice(1).map((value, index) => value - values[index]);
  let averageGain = changes.slice(0, period).reduce((sum, change) => sum + Math.max(change, 0), 0) / period;
  let averageLoss = changes.slice(0, period).reduce((sum, change) => sum + Math.max(-change, 0), 0) / period;
  for (const change of changes.slice(period)) {
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (averageLoss === 0) return 100;
  return 100 - (100 / (1 + averageGain / averageLoss));
}

function calculateIndicators(candles) {
  const closes = candles.map((candle) => Number(candle.close)).filter(Number.isFinite);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  return {
    candles: closes.length,
    sma20: sma(closes, 20),
    ema12,
    ema26,
    rsi14: rsi(closes),
    macd: ema12 === null || ema26 === null ? null : ema12 - ema26,
    trend: ema12 !== null && ema26 !== null ? (ema12 >= ema26 ? 'BULLISH' : 'BEARISH') : 'UNKNOWN'
  };
}

export { calculateIndicators, ema, rsi, sma };
