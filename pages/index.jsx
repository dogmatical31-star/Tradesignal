import Head from 'next/head'
import { useState, useEffect, useRef, useCallback } from "react";
import {
  ComposedChart, Line, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, ReferenceLine, Cell
} from "recharts";

const G = {
  bg: "#06080a", panel: "#0d1117", border: "#1c2330",
  green: "#00e676", greenDim: "rgba(0,230,118,0.15)",
  yellow: "#ffc107", yellowDim: "rgba(255,193,7,0.12)",
  red: "#ff5252", redDim: "rgba(255,82,82,0.12)",
  blue: "#4fc3f7", text: "#c9d1d9", muted: "#484f58", dim: "#21262d",
};

const calcEMA = (data, p) => {
  const k = 2 / (p + 1), out = [data[0]];
  for (let i = 1; i < data.length; i++) out.push(data[i] * k + out[i - 1] * (1 - k));
  return out;
};

const calcRSI = (closes, p = 14) => {
  if (closes.length < p + 1) return closes.map(() => 50);
  const rsi = Array(p).fill(null);
  let ag = 0, al = 0;
  for (let i = 1; i <= p; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) ag += d; else al -= d;
  }
  ag /= p; al /= p;
  rsi.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (p - 1) + Math.max(d, 0)) / p;
    al = (al * (p - 1) + Math.max(-d, 0)) / p;
    rsi.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  }
  return rsi;
};

const calcMACD = (closes, fast = 12, slow = 26, sig = 9) => {
  const ef = calcEMA(closes, fast), es = calcEMA(closes, slow);
  const line = ef.map((v, i) => v - es[i]);
  const signal = calcEMA(line, sig);
  const hist = line.map((v, i) => v - signal[i]);
  return { line, signal, hist };
};

const calcSMA = (data, p) =>
  data.map((_, i) => i < p - 1 ? null : data.slice(i - p + 1, i + 1).reduce((a, b) => a + b, 0) / p);

const isDowntrend = (candles) => {
  if (candles.length < 25) return false;
  const closes = candles.map(c => c.close);
  const sma = calcSMA(closes, 20);
  const len = sma.length;
  return closes[len - 1] < sma[len - 1] && sma[len - 1] < sma[len - 6];
};

const detectRSIDivergence = (candles, rsi, win = 30) => {
  if (candles.length < win) return false;
  const rc = candles.slice(-win), rr = rsi.slice(-win);
  const lows = [];
  for (let i = 2; i < rc.length - 2; i++) {
    if (rc[i].low < rc[i-1].low && rc[i].low < rc[i-2].low &&
        rc[i].low < rc[i+1].low && rc[i].low < rc[i+2].low && rr[i] != null)
      lows.push({ price: rc[i].low, rsi: rr[i] });
  }
  if (lows.length < 2) return false;
  const [a, b] = lows.slice(-2);
  return b.price < a.price && b.rsi > a.rsi;
};

const detectMACDBullish = (hist, look = 5) => {
  if (hist.length < look + 1) return false;
  const rec = hist.slice(-look);
  return rec.some((v, i) => i > 0 && rec[i-1] < 0 && v >= 0);
};

const detectEngulfing = (candles) => {
  if (candles.length < 2) return false;
  const [p, c] = candles.slice(-2);
  return p.close < p.open && c.close > c.open && c.open <= p.close && c.close >= p.open;
};

const analyzeCandles = (candles) => {
  if (!candles || candles.length < 30) return null;
  const closes = candles.map(c => c.close);
  const rsi = calcRSI(closes);
  const { hist, line, signal } = calcMACD(closes);
  const down = isDowntrend(candles);
  const rsiDiv = detectRSIDivergence(candles, rsi);
  const macdBull = detectMACDBullish(hist);
  const engulf = detectEngulfing(candles);
  const cond1 = down && rsiDiv && macdBull;
  const cond2 = cond1 && engulf;
  const lastRSI = rsi.filter(r => r != null).at(-1);
  const lastMACD = hist.at(-1);
  return {
    rsi: lastRSI?.toFixed(1), macd: lastMACD?.toFixed(4),
    down, rsiDiv, macdBull, engulf, cond1, cond2,
    rsiArr: rsi, macdArr: hist, macdLine: line, macdSig: signal
  };
};

const PROXY = "https://api.allorigins.win/raw?url=";

const fetchCandles = async (ticker) => {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1h&range=60d`;
    const res = await fetch(PROXY + encodeURIComponent(url));
    const data = await res.json();
    const r = data?.chart?.result?.[0];
    if (!r) throw new Error("no data");
    const { timestamp: ts, indicators: { quote: [q] } } = r;
    const candles = ts.map((t, i) => ({
      time: new Date(t * 1000).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit" }),
      timestamp: t * 1000,
      open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i],
    })).filter(c => c.open != null && c.high != null && !isNaN(c.close));
    const lastPrice = candles.at(-1)?.close;
    const prevPrice = candles.at(-2)?.close;
    const change = prevPrice ? ((lastPrice - prevPrice) / prevPrice * 100).toFixed(2) : "0.00";
    return { candles, price: lastPrice?.toFixed(2), change, source: "live" };
  } catch {
    return { candles: generateMockCandles(ticker), price: null, change: "0.00", source: "demo" };
  }
};

/* ── 스나이퍼용 일봉 데이터 (2년치) ── */
const fetchDailyCandles = async (ticker) => {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=730d`;
    const res = await fetch(PROXY + encodeURIComponent(url));
    const data = await res.json();
    const r = data?.chart?.result?.[0];
    if (!r) throw new Error("no data");
    const { timestamp: ts, indicators: { quote: [q] } } = r;
    const candles = ts.map((t, i) => ({
      time: new Date(t * 1000).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" }),
      timestamp: t * 1000,
      open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i],
    })).filter(c => c.open != null && c.high != null && !isNaN(c.close));
    return { candles, source: "live" };
  } catch {
    return { candles: generateMockDailyCandles(ticker), source: "demo" };
  }
};

const generateMockDailyCandles = (ticker, count = 500) => {
  let price = 100 + (ticker.charCodeAt(0) * 3.7) % 400;
  return Array.from({ length: count }, (_, i) => {
    const trend = Math.sin(i / 60) * 0.003; // 사이클 있는 추세
    const noise = (Math.random() - 0.5) * price * 0.018;
    price = Math.max(10, price * (1 + trend) + noise);
    const range = price * 0.012;
    const open = price + (Math.random() - 0.5) * range;
    const close = price + (Math.random() - 0.5) * range;
    const high = Math.max(open, close) + Math.random() * range;
    const low = Math.min(open, close) - Math.random() * range;
    return {
      time: new Date(Date.now() - (count - i) * 86400000).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" }),
      timestamp: Date.now() - (count - i) * 86400000,
      open, high, low, close, volume: Math.floor(500000 + Math.random() * 2e6),
    };
  });
};

const generateMockCandles = (ticker, count = 500) => {
  let price = 100 + (ticker.charCodeAt(0) * 3.7) % 400;
  const trend = -0.002;
  return Array.from({ length: count }, (_, i) => {
    const noise = (Math.random() - 0.5) * price * 0.02;
    price = price * (1 + trend) + noise;
    const range = price * 0.01;
    const open = price + (Math.random() - 0.5) * range;
    const close = price + (Math.random() - 0.5) * range;
    const high = Math.max(open, close) + Math.random() * range;
    const low = Math.min(open, close) - Math.random() * range;
    return {
      time: new Date(Date.now() - (count - i) * 3600000).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit" }),
      timestamp: Date.now() - (count - i) * 3600000,
      open, high, low, close, volume: Math.floor(Math.random() * 5e6),
    };
  });
};

/* ── 스나이퍼 전략 지표 ── */
const calcBB = (closes, p = 20, mult = 2) =>
  closes.map((_, i) => {
    if (i < p - 1) return { upper: null, lower: null };
    const sl = closes.slice(i - p + 1, i + 1);
    const mid = sl.reduce((a, b) => a + b, 0) / p;
    const std = Math.sqrt(sl.reduce((a, b) => a + (b - mid) ** 2, 0) / p);
    return { upper: mid + mult * std, lower: mid - mult * std, mid };
  });

const calcStoch = (candles, k = 14, d = 3) => {
  const kArr = candles.map((_, i) => {
    if (i < k - 1) return null;
    const sl = candles.slice(i - k + 1, i + 1);
    const hi = Math.max(...sl.map(c => c.high)), lo = Math.min(...sl.map(c => c.low));
    return hi === lo ? 50 : (candles[i].close - lo) / (hi - lo) * 100;
  });
  const dArr = kArr.map((_, i) => {
    const valid = kArr.slice(Math.max(0, i - d + 1), i + 1).filter(v => v != null);
    return valid.length >= d ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
  });
  return { k: kArr, d: dArr };
};

/* ── 스나이퍼 v3: 상승장 눌림목 전략 ── */
const runSniperBacktest = (candles, spyCandles = null) => {
  if (!candles || candles.length < 70) return null;
  const closes = candles.map(c => c.close);
  const rsi = calcRSI(closes);
  const sma20 = calcSMA(closes, 20);
  const sma60 = calcSMA(closes, 60);
  const sma20v = calcSMA(candles.map(c => c.volume), 20);
  const bb = calcBB(closes);
  const trades = [];

  // SPY 상승장 판단 - 날짜키(YYYY-MM-DD) 기반 Map으로 완전 고정
  const toDateKey = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  };
  const spyMap = new Map();
  if (spyCandles && spyCandles.length > 60) {
    const spyCloses = spyCandles.map(c => c.close);
    const spySma60 = calcSMA(spyCloses, 60);
    spyCandles.forEach((c, i) => {
      if (spySma60[i] != null) {
        spyMap.set(toDateKey(c.timestamp), spyCloses[i] > spySma60[i]);
      }
    });
  }
  const isMarketUp = (ts) => {
    if (!spyMap.size) return true;
    const key = toDateKey(ts);
    const val = spyMap.get(key);
    return val !== false; // undefined(데이터없음)는 허용, false만 차단
  };

  for (let i = 65; i < candles.length - 5; i++) {
    const r = rsi[i];
    if (!r || !sma20[i] || !sma60[i]) continue;

    // ① 시장 필터: SPY 60일선 위 (상승장)
    if (!isMarketUp(candles[i].timestamp)) continue;

    // ② 종목 상승추세: 종가 > 60일선
    if (closes[i] < sma60[i]) continue;

    // ③ 눌림목: RSI 40~58 (과매도 아닌 조정)
    if (r < 40 || r > 58) continue;

    // ④ 20일선 근처 지지: 종가가 20일선 ±4% 이내
    const sma20Ratio = closes[i] / sma20[i];
    if (sma20Ratio < 0.96 || sma20Ratio > 1.04) continue;

    // ⑤ 거래량 평균 이상
    if (!sma20v[i] || candles[i].volume < sma20v[i] * 0.9) continue;

    // ⑥ 당일 양봉 (눌림 후 반등 시작)
    if (candles[i].close <= candles[i].open) continue;

    // ⑦ 전날보다 RSI 상승 (모멘텀 확인)
    if (rsi[i-1] != null && r <= rsi[i-1]) continue;

    // 분할 익절: 1부 +5%, 2부 +10% 또는 BB상단
    const entry = candles[i].close;
    const stop = sma20[i] * 0.98;   // 20일선 -2% 손절
    const take1 = entry * 1.05;     // 1부 +5%
    const take2 = entry * 1.10;     // 2부 +10%
    let exit1 = null, exit2 = null, reason1 = "", reason2 = "";

    for (let j = i + 1; j < Math.min(i + 25, candles.length); j++) {
      // 손절: 20일선 -2% 이탈
      const curStop = sma20[j] ? sma20[j] * 0.98 : stop;
      if (candles[j].low <= curStop) {
        if (!exit1) { exit1 = curStop; reason1 = "손절"; }
        if (!exit2) { exit2 = curStop; reason2 = "손절"; }
        break;
      }
      if (!exit1 && candles[j].high >= take1) { exit1 = take1; reason1 = "익절(+5%)"; }
      if (exit1 && !exit2) {
        if (candles[j].high >= take2) { exit2 = take2; reason2 = "익절(+10%)"; break; }
        if (bb[j].upper && candles[j].high >= bb[j].upper) { exit2 = bb[j].upper; reason2 = "익절(BB상단)"; break; }
        if (rsi[j] != null && rsi[j] >= 70) { exit2 = candles[j].close; reason2 = "익절(RSI70)"; break; }
        // 20일선 다시 이탈하면 2부도 청산
        if (sma20[j] && candles[j].close < sma20[j] * 0.98) { exit2 = candles[j].close; reason2 = "손절(20일선)"; break; }
      }
    }
    if (!exit1) { exit1 = candles[Math.min(i + 15, candles.length - 1)].close; reason1 = "시간"; }
    if (!exit2) { exit2 = candles[Math.min(i + 20, candles.length - 1)].close; reason2 = "시간"; }

    const pnl1 = (exit1 - entry) / entry * 100;
    const pnl2 = (exit2 - entry) / entry * 100;

    trades.push({
      bar: i, time: candles[i].time,
      entry: entry.toFixed(2),
      exit1: exit1.toFixed(2), exit2: exit2.toFixed(2),
      pnl1: pnl1.toFixed(2), pnl2: pnl2.toFixed(2),
      pnl: ((pnl1 + pnl2) / 2).toFixed(2),
      reason: `1부 ${reason1} / 2부 ${reason2}`,
    });
    i += 3;
  }

  // 디버그
  let d1=0,d2=0,d3=0,d4=0,d5=0,d6=0,d7=0;
  for (let i = 65; i < candles.length - 5; i++) {
    if (!isMarketUp(candles[i].timestamp)) continue; d1++;
    const r = rsi[i]; if (!r || !sma20[i] || !sma60[i]) continue;
    if (closes[i] < sma60[i]) continue; d2++;
    if (r < 40 || r > 58) continue; d3++;
    const rt = closes[i] / sma20[i]; if (rt < 0.96 || rt > 1.04) continue; d4++;
    if (!sma20v[i] || candles[i].volume < sma20v[i] * 0.9) continue; d5++;
    if (candles[i].close <= candles[i].open) continue; d6++;
    if (rsi[i-1] != null && r <= rsi[i-1]) continue; d7++;
  }
  const debugInfo = `캔들:${candles.length} | 상승장:${d1} | 60선위:${d2} | RSI눌림:${d3} | 20선근처:${d4} | 거래량:${d5} | 양봉:${d6} | 모멘텀:${d7}`;

  if (!trades.length) return { trades, winRate: 0, avgPnl: 0, totalPnl: 0, debugInfo };
  const wins = trades.filter(t => parseFloat(t.pnl) > 0).length;
  const totalPnl = trades.reduce((a, t) => a + parseFloat(t.pnl), 0);
  return {
    trades,
    winRate: (wins / trades.length * 100).toFixed(1),
    avgPnl: (totalPnl / trades.length).toFixed(2),
    totalPnl: totalPnl.toFixed(2),
    debugInfo,
  };
};


const runBacktest = (candles, holdBars = 6, stopPct = 0.02, takePct = 0.04) => {
  if (!candles || candles.length < 50) return null;
  const closes = candles.map(c => c.close);
  const trades = [];
  for (let i = 50; i < candles.length - holdBars; i++) {
    const slice = candles.slice(0, i + 1);
    const rsi = calcRSI(closes.slice(0, i + 1));
    const { hist } = calcMACD(closes.slice(0, i + 1));
    if (isDowntrend(slice) && detectRSIDivergence(slice, rsi) &&
        detectMACDBullish(hist) && detectEngulfing(slice)) {
      const entry = candles[i].close;
      const stop = entry * (1 - stopPct), take = entry * (1 + takePct);
      let exit = candles[i + holdBars].close, exitBar = holdBars, reason = "시간";
      for (let j = 1; j <= holdBars; j++) {
        if (candles[i + j].low <= stop) { exit = stop; exitBar = j; reason = "손절"; break; }
        if (candles[i + j].high >= take) { exit = take; exitBar = j; reason = "익절"; break; }
      }
      const pnl = (exit - entry) / entry * 100;
      trades.push({ bar: i, entry: entry.toFixed(2), exit: exit.toFixed(2), pnl: pnl.toFixed(2), exitBar, reason, time: candles[i].time });
    }
  }
  if (!trades.length) return { trades, winRate: 0, avgPnl: 0, totalPnl: 0 };
  const wins = trades.filter(t => parseFloat(t.pnl) > 0).length;
  const totalPnl = trades.reduce((a, t) => a + parseFloat(t.pnl), 0);
  return { trades, winRate: (wins / trades.length * 100).toFixed(1), avgPnl: (totalPnl / trades.length).toFixed(2), totalPnl: totalPnl.toFixed(2) };
};

const CandleChart = ({ candles }) => {
  const ref = useRef();
  const [w, setW] = useState(360);
  useEffect(() => {
    const ob = new ResizeObserver(e => setW(e[0].contentRect.width));
    if (ref.current) ob.observe(ref.current);
    return () => ob.disconnect();
  }, []);

  if (!candles || candles.length < 2) return (
    <div style={{ height: 200, display: "flex", alignItems: "center", justifyContent: "center", color: G.muted, fontSize: 12 }}>로딩 중...</div>
  );

  const show = candles.slice(-60);
  const pl = 4, pr = 32, pt = 8, pb = 20;
  const ch = 200, chartW = w - pl - pr, chartH = ch - pt - pb;
  const prices = show.flatMap(c => [c.high, c.low]);
  const minP = Math.min(...prices) * 0.999, maxP = Math.max(...prices) * 1.001;
  const toY = v => pt + chartH * (1 - (v - minP) / (maxP - minP));
  const barW = Math.max(2, chartW / show.length - 1);
  const toX = i => pl + (i + 0.5) * (chartW / show.length);

  return (
    <div ref={ref} style={{ width: "100%", overflowX: "hidden" }}>
      <svg width={w} height={ch} style={{ display: "block" }}>
        {[0.25, 0.5, 0.75].map(r => (
          <line key={r} x1={pl} x2={w - pr} y1={pt + chartH * r} y2={pt + chartH * r} stroke={G.border} strokeWidth={0.5} />
        ))}
        {show.map((c, i) => {
          const x = toX(i), isBull = c.close >= c.open;
          const col = isBull ? G.green : G.red;
          const bodyTop = toY(Math.max(c.open, c.close));
          const bodyBot = toY(Math.min(c.open, c.close));
          const bodyH = Math.max(bodyBot - bodyTop, 1.5);
          return (
            <g key={i}>
              <line x1={x} y1={toY(c.high)} x2={x} y2={toY(c.low)} stroke={col} strokeWidth={1} opacity={0.7} />
              <rect x={x - barW / 2} y={bodyTop} width={barW} height={bodyH} fill={col} opacity={0.85} rx={0.5} />
            </g>
          );
        })}
        {[0, 0.5, 1].map(r => {
          const val = minP + (maxP - minP) * (1 - r);
          return <text key={r} x={w - pr + 3} y={pt + chartH * r + 4} fontSize={9} fill={G.muted}>{val.toFixed(0)}</text>;
        })}
        {[0, show.length - 1].map(i => (
          show[i] && <text key={i} x={toX(i)} y={ch - 4} fontSize={8} fill={G.muted} textAnchor="middle">{show[i].time}</text>
        ))}
      </svg>
    </div>
  );
};

const RSIChart = ({ rsiArr, candles }) => {
  const show = 60;
  const data = (rsiArr || []).slice(-show).map((v, i) => ({
    r: v != null ? parseFloat(v.toFixed(1)) : null,
    t: candles?.slice(-show)?.[i]?.time,
  }));
  return (
    <ResponsiveContainer width="100%" height={80}>
      <ComposedChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
        <YAxis domain={[0, 100]} hide />
        <XAxis dataKey="t" hide />
        <Tooltip contentStyle={{ background: G.panel, border: `1px solid ${G.border}`, fontSize: 10, color: G.text }} formatter={v => [v?.toFixed(1), "RSI"]} />
        <ReferenceLine y={30} stroke={G.green} strokeDasharray="3 3" strokeWidth={0.8} />
        <ReferenceLine y={70} stroke={G.red} strokeDasharray="3 3" strokeWidth={0.8} />
        <Line type="monotone" dataKey="r" dot={false} stroke={G.blue} strokeWidth={1.5} connectNulls />
      </ComposedChart>
    </ResponsiveContainer>
  );
};

const MACDChart = ({ macdLine, macdSig, macdHist, candles }) => {
  const show = 60;
  const data = (macdHist || []).slice(-show).map((v, i) => ({
    hist: v != null ? parseFloat(v.toFixed(4)) : null,
    line: macdLine?.slice(-show)[i] != null ? parseFloat(macdLine.slice(-show)[i].toFixed(4)) : null,
    sig: macdSig?.slice(-show)[i] != null ? parseFloat(macdSig.slice(-show)[i].toFixed(4)) : null,
    t: candles?.slice(-show)?.[i]?.time,
  }));
  return (
    <ResponsiveContainer width="100%" height={80}>
      <ComposedChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
        <YAxis hide />
        <XAxis dataKey="t" hide />
        <Tooltip contentStyle={{ background: G.panel, border: `1px solid ${G.border}`, fontSize: 10, color: G.text }} formatter={v => [v?.toFixed(4)]} />
        <ReferenceLine y={0} stroke={G.border} strokeWidth={1} />
        <Bar dataKey="hist" radius={[1, 1, 0, 0]}>
          {data.map((d, i) => <Cell key={i} fill={d.hist >= 0 ? G.green : G.red} opacity={0.7} />)}
        </Bar>
        <Line type="monotone" dataKey="line" dot={false} stroke={G.blue} strokeWidth={1.2} connectNulls />
        <Line type="monotone" dataKey="sig" dot={false} stroke={G.yellow} strokeWidth={1} strokeDasharray="3 2" connectNulls />
      </ComposedChart>
    </ResponsiveContainer>
  );
};

const Lbl = ({ active, text }) => (
  <span style={{
    display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 7px", borderRadius: 4,
    fontSize: 10, fontWeight: 600, letterSpacing: "0.03em",
    background: active ? G.greenDim : "rgba(255,255,255,0.03)",
    border: `1px solid ${active ? "rgba(0,230,118,0.35)" : G.border}`,
    color: active ? G.green : G.muted, transition: "all 0.3s",
  }}>
    <span style={{ width: 5, height: 5, borderRadius: "50%", background: active ? G.green : G.muted, boxShadow: active ? `0 0 5px ${G.green}` : "none" }} />
    {text}
  </span>
);

const Toast = ({ items, onDismiss }) => (
  <div style={{ position: "fixed", top: 16, right: 12, left: 12, zIndex: 999, display: "flex", flexDirection: "column", gap: 8 }}>
    {items.map(a => (
      <div key={a.id} style={{
        background: a.type === "cond2" ? "rgba(0,230,118,0.1)" : "rgba(255,193,7,0.08)",
        border: `1px solid ${a.type === "cond2" ? "rgba(0,230,118,0.4)" : "rgba(255,193,7,0.35)"}`,
        borderRadius: 10, padding: "12px 16px", backdropFilter: "blur(16px)",
        animation: "slideIn 0.3s ease",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: a.type === "cond2" ? G.green : G.yellow, marginBottom: 4 }}>
              {a.type === "cond2" ? "🚀 ENTRY SIGNAL" : "⚡ WATCH SIGNAL"}
            </div>
            <div style={{ fontSize: 15, fontWeight: 800, color: G.text }}>{a.ticker}</div>
            <div style={{ fontSize: 11, color: G.muted, marginTop: 2 }}>{a.msg}</div>
          </div>
          <button onClick={() => onDismiss(a.id)} style={{ background: "none", border: "none", color: G.muted, cursor: "pointer", fontSize: 18, padding: 0 }}>×</button>
        </div>
      </div>
    ))}
  </div>
);

let aidx = 0;
const DEFAULT_TICKERS = ["AAPL", "TSLA", "NVDA", "MSFT"];

export default function Home() {
  const [tab, setTab] = useState("dashboard");
  const [stocks, setStocks] = useState({});
  const [loading, setLoading] = useState({});
  const [selected, setSelected] = useState("AAPL");
  const [tickers, setTickers] = useState(DEFAULT_TICKERS);
  const [newTicker, setNewTicker] = useState("");
  const [toasts, setToasts] = useState([]);
  const [history, setHistory] = useState([]);
  const [btResult, setBtResult] = useState(null);
  const [btLoading, setBtLoading] = useState(false);
  const [btTicker, setBtTicker] = useState("AAPL");
  const [snResult, setSnResult] = useState(null);
  const [snLoading, setSnLoading] = useState(false);
  const [snTicker, setSnTicker] = useState("AAPL");
  const [slackWebhook, setSlackWebhook] = useState("");
  const [slackStatus, setSlackStatus] = useState("");
  const prevSignals = useRef({});

  useEffect(() => {
    try {
      const saved = localStorage.getItem("alert_history");
      if (saved) setHistory(JSON.parse(saved));
      const savedHook = localStorage.getItem("slack_webhook");
      if (savedHook) setSlackWebhook(savedHook);
      const savedTickers = localStorage.getItem("tickers");
      if (savedTickers) setTickers(JSON.parse(savedTickers));
    } catch {}
  }, []);

  const addToast = useCallback((ticker, type, msg, price) => {
    const id = ++aidx;
    setToasts(p => [...p.slice(-3), { id, ticker, type, msg }]);
    const entry = { id, ticker, type, msg, time: new Date().toLocaleString("ko-KR"), price };
    setHistory(h => {
      const next = [entry, ...h].slice(0, 200);
      try { localStorage.setItem("alert_history", JSON.stringify(next)); } catch {}
      return next;
    });
    if (slackWebhook) {
      try {
        fetch(slackWebhook, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: `[TradeSignal] ${type === "cond2" ? "🚀 ENTRY" : "⚡ WATCH"} ${ticker}${price ? ` $${price}` : ""} — ${msg}` }),
        });
      } catch {}
    }
    setTimeout(() => setToasts(p => p.filter(a => a.id !== id)), 8000);
  }, [slackWebhook]);

  const loadStock = useCallback(async (ticker) => {
    setLoading(p => ({ ...p, [ticker]: true }));
    const { candles, price, change, source } = await fetchCandles(ticker);
    const analysis = analyzeCandles(candles);
    const lastPrice = price || candles.at(-1)?.close?.toFixed(2);
    const prev = candles.at(-2)?.close, curr = candles.at(-1)?.close;
    const chg = prev ? ((curr - prev) / prev * 100).toFixed(2) : change;
    setStocks(p => ({ ...p, [ticker]: { candles, price: lastPrice, change: chg, source, ...analysis } }));
    setLoading(p => ({ ...p, [ticker]: false }));
    return { analysis, price: lastPrice };
  }, []);

  useEffect(() => {
    const load = async () => {
      for (const t of tickers) {
        const { analysis, price } = await loadStock(t);
        if (!analysis) continue;
        const prev = prevSignals.current[t] || {};
        if (analysis.cond2 && !prev.cond2) addToast(t, "cond2", "장대양봉으로 음봉 감싸기 확인! 진입 검토", price);
        else if (analysis.cond1 && !prev.cond1) addToast(t, "cond1", "조건 1 충족 — 장대양봉 대기 중", price);
        prevSignals.current[t] = { cond1: analysis.cond1, cond2: analysis.cond2 };
      }
    };
    load();
    const interval = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [tickers, loadStock, addToast]);

  const addTicker = async () => {
    const t = newTicker.toUpperCase().trim();
    if (!t || tickers.includes(t)) return;
    const next = [...tickers, t];
    setTickers(next);
    try { localStorage.setItem("tickers", JSON.stringify(next)); } catch {}
    setNewTicker("");
    await loadStock(t);
  };

  const removeTicker = (t) => {
    const next = tickers.filter(x => x !== t);
    setTickers(next);
    try { localStorage.setItem("tickers", JSON.stringify(next)); } catch {}
  };

  const runBT = async () => {
    setBtLoading(true);
    const { candles } = await fetchDailyCandles(btTicker); // 일봉 2년치로 통일
    setBtResult(runBacktest(candles, 30, 0.05, 0.08)); // 일봉 기준: 최대30일, 손절5%, 익절8%
    setBtLoading(false);
  };

  const runSN = async () => {
    setSnLoading(true);
    // 종목 데이터 + SPY 시장 추세 동시 로딩
    const [{ candles, source }, { candles: spyCandles }] = await Promise.all([
      fetchDailyCandles(snTicker),
      fetchDailyCandles("SPY"),
    ]);
    setSnResult({ ...runSniperBacktest(candles, spyCandles), source });
    setSnLoading(false);
  };

  const selData = stocks[selected] || {};
  const alertCount = Object.values(stocks).filter(s => s?.cond1 || s?.cond2).length;

  const TABS = [
    { id: "dashboard", icon: "◉", label: "대시보드" },
    { id: "chart", icon: "↗", label: "차트" },
    { id: "backtest", icon: "◷", label: "백테스트" },
    { id: "sniper", icon: "🎯", label: "스나이퍼" },
    { id: "history", icon: "☰", label: "히스토리" },
    { id: "settings", icon: "⚙", label: "설정" },
  ];

  return (
    <>
      <Head>
        <title>TradeSignal PRO</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
        <meta name="theme-color" content="#06080a" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="TradeSignal" />
        <link rel="manifest" href="/manifest.json" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&display=swap" rel="stylesheet" />
      </Head>

      <div style={{ minHeight: "100vh", minHeight: "100dvh", background: G.bg, paddingBottom: 70, position: "relative" }}>
        <Toast items={toasts} onDismiss={(id) => setToasts(p => p.filter(a => a.id !== id))} />

        {/* Header */}
        <div style={{ background: "rgba(13,17,23,0.97)", borderBottom: `1px solid ${G.border}`, backdropFilter: "blur(10px)", position: "sticky", top: 0, zIndex: 90, padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 18 }}>📡</span>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: "0.08em" }}>TRADESIGNAL</div>
              <div style={{ fontSize: 9, color: G.muted, letterSpacing: "0.06em" }}>1H AUTO SCANNER</div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {alertCount > 0 && (
              <div style={{ background: G.greenDim, border: `1px solid rgba(0,230,118,0.4)`, borderRadius: 4, padding: "2px 8px", fontSize: 10, color: G.green, animation: "blink 2s infinite", letterSpacing: "0.04em" }}>
                {alertCount} SIGNAL
              </div>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: G.green, boxShadow: `0 0 6px ${G.green}`, animation: "blink 3s infinite" }} />
              <span style={{ fontSize: 10, color: G.muted }}>LIVE</span>
            </div>
          </div>
        </div>

        {/* Content */}
        <div style={{ padding: "16px 14px" }}>

          {/* DASHBOARD */}
          {tab === "dashboard" && (
            <div style={{ animation: "fadeUp 0.3s ease" }}>
              <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                <input value={newTicker} onChange={e => setNewTicker(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && addTicker()}
                  placeholder="종목 추가 (예: GOOG)"
                  style={{ flex: 1, background: G.panel, border: `1px solid ${G.border}`, borderRadius: 8, padding: "9px 12px", color: G.text, fontSize: 12 }} />
                <button onClick={addTicker} style={{ padding: "9px 14px", background: G.greenDim, border: `1px solid rgba(0,230,118,0.3)`, borderRadius: 8, color: G.green, fontSize: 12, fontWeight: 700 }}>＋</button>
                <button onClick={() => tickers.forEach(t => loadStock(t))} style={{ padding: "9px 12px", background: G.dim, border: `1px solid ${G.border}`, borderRadius: 8, color: G.muted, fontSize: 14 }}>↻</button>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {tickers.map(ticker => {
                  const s = stocks[ticker] || {};
                  const isLoad = loading[ticker];
                  const sig = s.cond2 ? "cond2" : s.cond1 ? "cond1" : "none";
                  const borderCol = sig === "cond2" ? `rgba(0,230,118,0.4)` : sig === "cond1" ? `rgba(255,193,7,0.3)` : G.border;
                  return (
                    <div key={ticker} style={{ background: G.panel, border: `1px solid ${borderCol}`, borderRadius: 12, padding: 16, position: "relative", overflow: "hidden" }}>
                      {sig !== "none" && <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: sig === "cond2" ? `linear-gradient(90deg, transparent, ${G.green}, transparent)` : `linear-gradient(90deg, transparent, ${G.yellow}, transparent)`, animation: "blink 2s infinite" }} />}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                          <div>
                            <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: "0.05em" }}>{ticker}</div>
                            <div style={{ fontSize: 10, color: s.source === "demo" ? G.yellow : G.muted }}>{isLoad ? "로딩..." : s.source === "demo" ? "DEMO" : "LIVE"}</div>
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                          {s.price && (
                            <div style={{ textAlign: "right" }}>
                              <div style={{ fontSize: 16, fontWeight: 700 }}>${s.price}</div>
                              <div style={{ fontSize: 12, color: parseFloat(s.change) >= 0 ? G.green : G.red }}>
                                {parseFloat(s.change) >= 0 ? "+" : ""}{s.change}%
                              </div>
                            </div>
                          )}
                          <button onClick={() => { setSelected(ticker); setTab("chart"); }} style={{ background: G.dim, border: `1px solid ${G.border}`, borderRadius: 6, padding: "4px 10px", color: G.muted, fontSize: 11 }}>차트</button>
                        </div>
                      </div>

                      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 10 }}>
                        <Lbl active={s.down} text="하락추세" />
                        <Lbl active={s.rsiDiv} text="RSI다이버전스" />
                        <Lbl active={s.macdBull} text="MACD↑" />
                        {s.cond1 && <Lbl active={s.engulf} text="장대양봉" />}
                      </div>

                      {s.rsi && (
                        <div style={{ display: "flex", gap: 16, marginBottom: s.cond1 ? 10 : 0 }}>
                          <span style={{ fontSize: 11, color: G.muted }}>RSI <span style={{ color: G.text }}>{s.rsi}</span></span>
                          <span style={{ fontSize: 11, color: G.muted }}>MACD <span style={{ color: parseFloat(s.macd) >= 0 ? G.green : G.red }}>{s.macd}</span></span>
                        </div>
                      )}

                      {(s.cond1 || s.cond2) && (
                        <div style={{ padding: "8px 12px", borderRadius: 8, background: s.cond2 ? G.greenDim : G.yellowDim, border: `1px solid ${s.cond2 ? "rgba(0,230,118,0.3)" : "rgba(255,193,7,0.3)"}`, fontSize: 12, fontWeight: 700, color: s.cond2 ? G.green : G.yellow }}>
                          {s.cond2 ? "🟢 매수 진입 신호!" : "🟡 장대양봉 대기 중"}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* CHART */}
          {tab === "chart" && (
            <div style={{ animation: "fadeUp 0.3s ease" }}>
              <div style={{ display: "flex", gap: 6, marginBottom: 14, overflowX: "auto", paddingBottom: 4 }}>
                {tickers.map(t => (
                  <button key={t} onClick={() => setSelected(t)} style={{
                    padding: "6px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, flexShrink: 0,
                    background: selected === t ? G.greenDim : G.dim,
                    border: `1px solid ${selected === t ? "rgba(0,230,118,0.4)" : G.border}`,
                    color: selected === t ? G.green : G.muted,
                  }}>{t}</button>
                ))}
              </div>

              {selData.candles ? (
                <>
                  <div style={{ background: G.panel, border: `1px solid ${G.border}`, borderRadius: 12, padding: "14px 12px", marginBottom: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                      <div>
                        <span style={{ fontSize: 18, fontWeight: 700 }}>{selected}</span>
                        {selData.price && <span style={{ fontSize: 13, marginLeft: 10 }}>${selData.price}</span>}
                        {selData.change && <span style={{ fontSize: 12, marginLeft: 6, color: parseFloat(selData.change) >= 0 ? G.green : G.red }}>{parseFloat(selData.change) >= 0 ? "+" : ""}{selData.change}%</span>}
                      </div>
                      <span style={{ fontSize: 9, color: selData.source === "demo" ? G.yellow : G.muted, alignSelf: "center" }}>{selData.source === "demo" ? "⚠ DEMO" : "● LIVE"}</span>
                    </div>
                    <div style={{ fontSize: 9, color: G.muted, marginBottom: 6, letterSpacing: "0.06em" }}>PRICE  1H</div>
                    <CandleChart candles={selData.candles} />
                  </div>

                  <div style={{ background: G.panel, border: `1px solid ${G.border}`, borderRadius: 12, padding: "12px", marginBottom: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ fontSize: 9, color: G.muted, letterSpacing: "0.06em" }}>RSI (14)</span>
                      <span style={{ fontSize: 9, color: selData.rsiDiv ? G.green : G.muted }}>{selData.rsiDiv ? "▲ 다이버전스" : ""} {selData.rsi}</span>
                    </div>
                    <RSIChart rsiArr={selData.rsiArr} candles={selData.candles} />
                  </div>

                  <div style={{ background: G.panel, border: `1px solid ${G.border}`, borderRadius: 12, padding: "12px", marginBottom: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ fontSize: 9, color: G.muted, letterSpacing: "0.06em" }}>MACD (12,26,9)</span>
                      <span style={{ fontSize: 9, color: selData.macdBull ? G.green : G.muted }}>{selData.macdBull ? "▲ 상승전환" : ""} {selData.macd}</span>
                    </div>
                    <MACDChart macdLine={selData.macdLine} macdSig={selData.macdSig} macdHist={selData.macdArr} candles={selData.candles} />
                  </div>

                  <div style={{ background: G.panel, border: `1px solid ${G.border}`, borderRadius: 12, padding: 16 }}>
                    <div style={{ fontSize: 10, color: G.muted, letterSpacing: "0.08em", marginBottom: 12 }}>CONDITION CHECK</div>
                    {[
                      { label: "1H 하락추세", active: selData.down, note: "SMA20 기준" },
                      { label: "RSI 상승다이버전스", active: selData.rsiDiv, note: `RSI ${selData.rsi}` },
                      { label: "MACD 상승 전환", active: selData.macdBull, note: `${selData.macd}` },
                      { label: "장대양봉 (음봉포함)", active: selData.engulf, note: "최근 2봉 기준", dim: !selData.cond1 },
                    ].map((c, i) => (
                      <div key={i} style={{ display: "flex", gap: 10, padding: "9px 0", borderBottom: `1px solid ${G.dim}`, opacity: c.dim ? 0.4 : 1, alignItems: "center" }}>
                        <div style={{ width: 22, height: 22, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: c.active ? G.greenDim : G.dim, border: `1px solid ${c.active ? "rgba(0,230,118,0.4)" : G.border}`, fontSize: 11, color: c.active ? G.green : G.muted }}>
                          {c.active ? "✓" : i + 1}
                        </div>
                        <div>
                          <div style={{ fontSize: 12, color: c.active ? G.text : G.muted }}>{c.label}</div>
                          <div style={{ fontSize: 10, color: G.muted, marginTop: 1 }}>{c.note}</div>
                        </div>
                      </div>
                    ))}

                    <div style={{ marginTop: 14, padding: "12px 14px", borderRadius: 8, background: selData.cond2 ? G.greenDim : selData.cond1 ? G.yellowDim : G.dim, border: `1px solid ${selData.cond2 ? "rgba(0,230,118,0.3)" : selData.cond1 ? "rgba(255,193,7,0.3)" : G.border}` }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: selData.cond2 ? G.green : selData.cond1 ? G.yellow : G.muted, marginBottom: 4, letterSpacing: "0.06em" }}>
                        {selData.cond2 ? "ENTRY SIGNAL" : selData.cond1 ? "WATCH SIGNAL" : "MONITORING"}
                      </div>
                      <div style={{ fontSize: 12, color: G.muted, lineHeight: 1.6 }}>
                        {selData.cond2 ? "✅ 전체 조건 충족. 진입 검토 가능." : selData.cond1 ? "⚡ 조건 1 충족. 장대양봉 대기." : "🔍 조건 미충족. 모니터링 중."}
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div style={{ textAlign: "center", padding: 60, color: G.muted, fontSize: 13 }}>종목을 선택하세요</div>
              )}
            </div>
          )}

          {/* BACKTEST */}
          {tab === "backtest" && (
            <div style={{ animation: "fadeUp 0.3s ease" }}>
              <div style={{ background: G.panel, border: `1px solid ${G.border}`, borderRadius: 12, padding: 16, marginBottom: 14 }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12, letterSpacing: "0.06em" }}>백테스팅</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
                  {tickers.map(t => (
                    <button key={t} onClick={() => setBtTicker(t)} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: btTicker === t ? G.greenDim : G.dim, border: `1px solid ${btTicker === t ? "rgba(0,230,118,0.4)" : G.border}`, color: btTicker === t ? G.green : G.muted }}>{t}</button>
                  ))}
                </div>
                <button onClick={runBT} disabled={btLoading} style={{ width: "100%", padding: "12px", borderRadius: 8, background: btLoading ? G.dim : G.greenDim, border: `1px solid ${btLoading ? G.border : "rgba(0,230,118,0.4)"}`, color: btLoading ? G.muted : G.green, fontSize: 13, fontWeight: 700, letterSpacing: "0.08em" }}>
                  {btLoading ? "⏳ 실행 중..." : "▶ 백테스트 실행"}
                </button>
                <div style={{ fontSize: 10, color: G.muted, marginTop: 8, lineHeight: 1.7 }}>
                  📅 일봉 2년치 (스나이퍼와 동일 기간) · 진입: RSI다이버전스 + MACD + 장대양봉 · 익절 +8% · 손절 -5% · 최대 30일
                </div>
              </div>

              {btResult && (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
                    {[
                      { label: "총 거래", val: btResult.trades.length + "회" },
                      { label: "승률", val: btResult.winRate + "%", col: parseFloat(btResult.winRate) >= 50 ? G.green : G.red },
                      { label: "평균 수익", val: (parseFloat(btResult.avgPnl) >= 0 ? "+" : "") + btResult.avgPnl + "%", col: parseFloat(btResult.avgPnl) >= 0 ? G.green : G.red },
                      { label: "누적 수익", val: (parseFloat(btResult.totalPnl) >= 0 ? "+" : "") + btResult.totalPnl + "%", col: parseFloat(btResult.totalPnl) >= 0 ? G.green : G.red },
                    ].map(m => (
                      <div key={m.label} style={{ background: G.panel, border: `1px solid ${G.border}`, borderRadius: 10, padding: "14px 16px" }}>
                        <div style={{ fontSize: 10, color: G.muted, marginBottom: 6, letterSpacing: "0.06em" }}>{m.label}</div>
                        <div style={{ fontSize: 22, fontWeight: 700, color: m.col || G.text }}>{m.val}</div>
                      </div>
                    ))}
                  </div>

                  <div style={{ background: G.panel, border: `1px solid ${G.border}`, borderRadius: 12, overflow: "hidden" }}>
                    <div style={{ padding: "12px 16px", borderBottom: `1px solid ${G.border}`, fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", color: G.muted }}>거래 내역</div>
                    <div style={{ maxHeight: 320, overflowY: "auto" }}>
                      {btResult.trades.length === 0 ? (
                        <div style={{ padding: 32, textAlign: "center", color: G.muted, fontSize: 12 }}>해당 기간 신호 없음</div>
                      ) : btResult.trades.map((t, i) => (
                        <div key={i} style={{ display: "flex", gap: 8, padding: "10px 14px", borderBottom: `1px solid ${G.dim}`, fontSize: 11, alignItems: "center" }}>
                          <span style={{ color: G.muted, minWidth: 24 }}>#{i + 1}</span>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 10, color: G.muted }}>{t.time}</div>
                            <div style={{ marginTop: 2 }}>
                              <span style={{ color: G.muted }}>진입 </span><span>${t.entry}</span>
                              <span style={{ color: G.muted, margin: "0 6px" }}>→</span>
                              <span>${t.exit}</span>
                              <span style={{ color: G.muted, fontSize: 10, marginLeft: 6 }}>{t.reason}</span>
                            </div>
                          </div>
                          <span style={{ fontWeight: 700, color: parseFloat(t.pnl) >= 0 ? G.green : G.red }}>
                            {parseFloat(t.pnl) >= 0 ? "+" : ""}{t.pnl}%
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* SNIPER */}
          {tab === "sniper" && (
            <div style={{ animation: "fadeUp 0.3s ease" }}>
              {/* 전략 설명 */}
              <div style={{ background: "#0a1929", border: "1px solid rgba(79,195,247,0.3)", borderRadius: 12, padding: 14, marginBottom: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: G.blue, marginBottom: 8, letterSpacing: "0.06em" }}>🎯 스나이퍼 v3 — 상승장 눌림목</div>
                <div style={{ fontSize: 10, color: G.muted, lineHeight: 1.8 }}>
                  <span style={{ color: G.green }}>✅ 진입조건</span>: SPY+종목 60일선 위 (상승장)<br />
                  <span style={{ color: G.yellow }}>📉 눌림목</span>: RSI 40~58 + 20일선 ±4% + 양봉<br />
                  <span style={{ color: "#4fc3f7" }}>💰 분할 익절</span>: 1부 +5% / 2부 +10% or BB상단<br />
                  <span style={{ color: G.muted }}>🛡 손절: 20일선 -2% 이탈</span>
                </div>
              </div>

              {/* 종목 선택 + 실행 */}
              <div style={{ background: G.panel, border: `1px solid ${G.border}`, borderRadius: 12, padding: 16, marginBottom: 14 }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12, letterSpacing: "0.06em" }}>백테스팅 (스나이퍼)</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
                  {tickers.map(t => (
                    <button key={t} onClick={() => setSnTicker(t)} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: snTicker === t ? "rgba(79,195,247,0.15)" : G.dim, border: `1px solid ${snTicker === t ? "rgba(79,195,247,0.4)" : G.border}`, color: snTicker === t ? G.blue : G.muted }}>{t}</button>
                  ))}
                </div>
                <button onClick={runSN} disabled={snLoading} style={{ width: "100%", padding: "12px", borderRadius: 8, background: snLoading ? G.dim : "rgba(79,195,247,0.15)", border: `1px solid ${snLoading ? G.border : "rgba(79,195,247,0.4)"}`, color: snLoading ? G.muted : G.blue, fontSize: 13, fontWeight: 700, letterSpacing: "0.08em" }}>
                  {snLoading ? "⏳ 실행 중..." : "▶ 스나이퍼 백테스트 실행"}
                </button>
                <div style={{ fontSize: 10, color: G.muted, marginTop: 8, lineHeight: 1.7 }}>
                  📅 일봉 2년치 · 상승장 눌림목 전략 · SPY+종목 60일선 위 · RSI 40~58 눌림 · 20일선 지지 · 1부 +5% / 2부 +10% · 손절: 20일선 -2%
                </div>
              </div>

              {snResult && (
                <>
                  {/* 스탯 카드 */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
                    {[
                      { label: "총 거래", val: snResult.trades.length + "회" },
                      { label: "승률", val: snResult.winRate + "%", col: parseFloat(snResult.winRate) >= 50 ? G.green : G.red },
                      { label: "평균 수익(분할)", val: (parseFloat(snResult.avgPnl) >= 0 ? "+" : "") + snResult.avgPnl + "%", col: parseFloat(snResult.avgPnl) >= 0 ? G.green : G.red },
                      { label: "누적 수익", val: (parseFloat(snResult.totalPnl) >= 0 ? "+" : "") + snResult.totalPnl + "%", col: parseFloat(snResult.totalPnl) >= 0 ? G.green : G.red },
                    ].map(m => (
                      <div key={m.label} style={{ background: G.panel, border: `1px solid ${G.border}`, borderRadius: 10, padding: "14px 16px" }}>
                        <div style={{ fontSize: 10, color: G.muted, marginBottom: 6, letterSpacing: "0.06em" }}>{m.label}</div>
                        <div style={{ fontSize: 22, fontWeight: 700, color: m.col || G.text }}>{m.val}</div>
                      </div>
                    ))}
                  </div>

                  {/* 디버그 패널 */}
                  {snResult.debugInfo && (
                    <div style={{ background: "#0a1929", border: `1px solid ${G.border}`, borderRadius: 10, padding: 12, marginBottom: 14, fontSize: 10, color: G.blue, lineHeight: 1.8, wordBreak: "break-all" }}>
                      🔍 조건 통과 현황<br />
                      <span style={{ color: G.muted }}>{snResult.debugInfo}</span>
                    </div>
                  )}

                  {/* 거래 내역 */}
                  <div style={{ background: G.panel, border: `1px solid ${G.border}`, borderRadius: 12, overflow: "hidden" }}>
                    <div style={{ padding: "12px 16px", borderBottom: `1px solid ${G.border}`, fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", color: G.muted }}>거래 내역 (분할 익절)</div>
                    <div style={{ maxHeight: 360, overflowY: "auto" }}>
                      {snResult.trades.length === 0 ? (
                        <div style={{ padding: 32, textAlign: "center", color: G.muted, fontSize: 12 }}>해당 기간 신호 없음<br /><span style={{ fontSize: 10, marginTop: 6, display: "block" }}>조건이 까다로워 신호가 드물 수 있어요</span></div>
                      ) : snResult.trades.map((t, i) => (
                        <div key={i} style={{ padding: "10px 14px", borderBottom: `1px solid ${G.dim}` }}>
                          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                            <span style={{ fontSize: 10, color: G.muted }}>#{i + 1} {t.time}</span>
                            <span style={{ fontWeight: 700, fontSize: 13, color: parseFloat(t.pnl) >= 0 ? G.green : G.red }}>
                              {parseFloat(t.pnl) >= 0 ? "+" : ""}{t.pnl}%
                            </span>
                          </div>
                          <div style={{ display: "flex", gap: 6, marginBottom: 4 }}>
                            <span style={{ fontSize: 9, background: "rgba(0,230,118,0.1)", color: G.green, padding: "2px 7px", borderRadius: 4 }}>1부 {parseFloat(t.pnl1) >= 0 ? "+" : ""}{t.pnl1}%</span>
                            <span style={{ fontSize: 9, background: "rgba(79,195,247,0.1)", color: G.blue, padding: "2px 7px", borderRadius: 4 }}>2부 {parseFloat(t.pnl2) >= 0 ? "+" : ""}{t.pnl2}%</span>
                          </div>
                          <div style={{ fontSize: 10, color: G.muted }}>진입 ${t.entry} · {t.reason}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* HISTORY */}
          {tab === "history" && (
            <div style={{ animation: "fadeUp 0.3s ease" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.06em" }}>알림 히스토리</div>
                <button onClick={() => { setHistory([]); try { localStorage.removeItem("alert_history"); } catch {} }} style={{ padding: "5px 12px", borderRadius: 6, background: G.dim, border: `1px solid ${G.border}`, color: G.muted, fontSize: 10 }}>초기화</button>
              </div>
              <div style={{ background: G.panel, border: `1px solid ${G.border}`, borderRadius: 12, overflow: "hidden" }}>
                {history.length === 0 ? (
                  <div style={{ padding: 48, textAlign: "center", color: G.muted, fontSize: 12, lineHeight: 1.8 }}>알림 히스토리가 없습니다<br /><span style={{ fontSize: 10 }}>신호 감지 시 자동 저장됩니다</span></div>
                ) : history.map((h, i) => (
                  <div key={h.id} style={{ display: "flex", gap: 12, padding: "12px 14px", borderBottom: `1px solid ${G.dim}`, alignItems: "flex-start" }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, marginTop: 4, background: h.type === "cond2" ? G.green : G.yellow, boxShadow: `0 0 5px ${h.type === "cond2" ? G.green : G.yellow}` }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <span style={{ fontSize: 15, fontWeight: 700 }}>{h.ticker}</span>
                        {h.price && <span style={{ fontSize: 11, color: G.muted }}>${h.price}</span>}
                        <span style={{ fontSize: 9, background: h.type === "cond2" ? G.greenDim : G.yellowDim, color: h.type === "cond2" ? G.green : G.yellow, padding: "1px 6px", borderRadius: 3, letterSpacing: "0.06em" }}>{h.type === "cond2" ? "ENTRY" : "WATCH"}</span>
                      </div>
                      <div style={{ fontSize: 11, color: G.muted, marginTop: 3 }}>{h.msg}</div>
                      <div style={{ fontSize: 10, color: G.dim, marginTop: 3 }}>{h.time}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* SETTINGS */}
          {tab === "settings" && (
            <div style={{ animation: "fadeUp 0.3s ease" }}>
              <div style={{ background: G.panel, border: `1px solid ${G.border}`, borderRadius: 12, padding: 16, marginBottom: 14 }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4, letterSpacing: "0.06em" }}>Slack 알림</div>
                <div style={{ fontSize: 11, color: G.muted, marginBottom: 12, lineHeight: 1.7 }}>
                  Slack Incoming Webhook URL 입력 시 신호 발생마다 자동 전송됩니다
                </div>
                <input value={slackWebhook} onChange={e => setSlackWebhook(e.target.value)}
                  placeholder="https://hooks.slack.com/services/..."
                  style={{ width: "100%", background: G.dim, border: `1px solid ${G.border}`, borderRadius: 8, padding: "10px 12px", color: G.text, fontSize: 11, marginBottom: 10 }} />
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button onClick={() => { try { localStorage.setItem("slack_webhook", slackWebhook); setSlackStatus("✅ 저장됨"); } catch { setSlackStatus("❌ 오류"); } setTimeout(() => setSlackStatus(""), 2000); }} style={{ flex: 1, padding: "10px", background: G.greenDim, border: `1px solid rgba(0,230,118,0.3)`, borderRadius: 8, color: G.green, fontSize: 12, fontWeight: 700 }}>저장</button>
                  <button onClick={async () => {
                    if (!slackWebhook) { setSlackStatus("❌ URL 없음"); setTimeout(() => setSlackStatus(""), 2000); return; }
                    try { await fetch(slackWebhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "✅ TradeSignal 연결 성공!" }) }); setSlackStatus("✅ 전송됨"); } catch { setSlackStatus("❌ 실패"); }
                    setTimeout(() => setSlackStatus(""), 3000);
                  }} style={{ flex: 1, padding: "10px", background: G.dim, border: `1px solid ${G.border}`, borderRadius: 8, color: G.muted, fontSize: 12 }}>테스트</button>
                  {slackStatus && <span style={{ fontSize: 12, color: slackStatus.includes("✅") ? G.green : G.red }}>{slackStatus}</span>}
                </div>
              </div>

              <div style={{ background: G.panel, border: `1px solid ${G.border}`, borderRadius: 12, padding: 16, marginBottom: 14 }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12, letterSpacing: "0.06em" }}>감시 종목</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {tickers.map(t => (
                    <div key={t} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", background: G.dim, borderRadius: 8, border: `1px solid ${G.border}` }}>
                      <div>
                        <span style={{ fontSize: 14, fontWeight: 700 }}>{t}</span>
                        {stocks[t]?.price && <span style={{ fontSize: 11, color: G.muted, marginLeft: 10 }}>${stocks[t].price}</span>}
                      </div>
                      <button onClick={() => removeTicker(t)} style={{ background: "none", border: "none", color: G.red, fontSize: 16, opacity: 0.7, padding: "0 4px" }}>✕</button>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ background: G.panel, border: `1px solid ${G.border}`, borderRadius: 12, padding: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, letterSpacing: "0.06em" }}>PWA 설치 안내</div>
                <div style={{ fontSize: 12, color: G.muted, lineHeight: 2 }}>
                  📱 <span style={{ color: G.text }}>iPhone (Safari)</span><br />
                  <span style={{ paddingLeft: 20, display: "block" }}>하단 공유버튼 → "홈 화면에 추가"</span>
                  📱 <span style={{ color: G.text }}>Android (Chrome)</span><br />
                  <span style={{ paddingLeft: 20, display: "block" }}>메뉴(⋮) → "앱 설치" 또는 "홈 화면에 추가"</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Bottom Nav */}
        <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: "rgba(13,17,23,0.97)", borderTop: `1px solid ${G.border}`, backdropFilter: "blur(10px)", display: "flex", paddingBottom: "env(safe-area-inset-bottom, 0px)", zIndex: 90 }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{ flex: 1, padding: "8px 2px 6px", background: "none", border: "none", display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
              <span style={{ fontSize: 16, color: tab === t.id ? G.green : G.muted, transition: "color 0.2s" }}>
                {t.icon}
                {t.id === "history" && history.length > 0 && (
                  <span style={{ fontSize: 9, background: G.green, color: G.bg, borderRadius: "50%", padding: "0 3px", marginLeft: 2, verticalAlign: "top" }}>{history.length > 99 ? "99" : history.length}</span>
                )}
              </span>
              <span style={{ fontSize: 9, color: tab === t.id ? G.green : G.muted, letterSpacing: "0.04em", fontWeight: tab === t.id ? 600 : 400 }}>{t.label}</span>
              {tab === t.id && <span style={{ width: 4, height: 4, borderRadius: "50%", background: G.green, boxShadow: `0 0 5px ${G.green}` }} />}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
