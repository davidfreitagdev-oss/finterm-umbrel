#!/usr/bin/env node
'use strict';
/*
 * FinTerm – self-hosted financial terminal (backend)
 * ---------------------------------------------------
 * Zero npm dependencies, Node.js >= 18.
 * Serves public/index.html and a JSON API that proxies and caches free market
 * data (Yahoo Finance, FRED, ČNB, ForexFactory, CoinGecko, alternative.me,
 * CNN, mempool.space, RSS feeds), stores user state and runs price alerts.
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');

const VERSION = '1.2.1';
const PORT = parseInt(process.env.PORT || '8420', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const BASIC_AUTH = process.env.BASIC_AUTH || ''; // "user:password" – only for standalone (non-Umbrel) installs
const MEMPOOL_DEFAULT = (process.env.MEMPOOL_URL || 'https://mempool.space').replace(/\/+$/, '');
const ALLOW_PRIVATE_FEEDS = process.env.ALLOW_PRIVATE_FEEDS === '1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const STARTED = Date.now();

// ───────────────────────────── utils ─────────────────────────────
const log = (...a) => console.log(new Date().toISOString(), ...a);
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const hash = s => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);
const num = v => { if (v == null) return null; const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? n : null; };
const isoDate = ts => new Date(ts).toISOString().slice(0, 10);

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); } catch { out[idx] = undefined; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function downsample(arr, max) {
  if (arr.length <= max) return arr;
  const step = (arr.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i++) out.push(arr[Math.round(i * step)]);
  return out;
}

// ───────────────────────── source health ─────────────────────────
const health = {};
function mark(src, ok, err) {
  const h = health[src] || (health[src] = { ok: 0, fail: 0 });
  h.last = Date.now();
  h.status = ok ? 'ok' : 'error';
  if (ok) { h.ok++; h.lastOk = h.last; delete h.err; } else { h.fail++; h.err = String(err || '').slice(0, 200); }
}

// ───────────────────────────── cache ─────────────────────────────
// Memory cache with TTL, in-flight de-duplication and stale-on-error fallback.
const cache = new Map();
const inflight = new Map();
async function cached(key, ttl, fn, staleMax = 72 * 3600e3) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const v = await fn();
      cache.set(key, { v, t: Date.now() });
      return v;
    } catch (e) {
      if (hit && Date.now() - hit.t < staleMax) return hit.v;
      throw e;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.t > 72 * 3600e3) cache.delete(k);
  if (cache.size > 6000) [...cache.keys()].slice(0, cache.size - 5000).forEach(k => cache.delete(k));
}, 15 * 60e3).unref();

// ───────────────────────────── HTTP client ─────────────────────────────
class HttpError extends Error { constructor(status, url) { super(`HTTP ${status}`); this.status = status; this.url = url; } }

function fetchRaw(url, opts = {}) {
  const { headers = {}, timeout = 15000, method = 'GET', body, redirect = 'follow' } = opts;
  return fetch(url, {
    method, body, redirect,
    headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9,cs;q=0.8', ...headers },
    signal: AbortSignal.timeout(timeout),
  });
}

function decodeBody(buf, ctype) {
  let cs = (ctype.match(/charset=["']?([\w-]+)/i) || [])[1];
  if (!cs) cs = (buf.subarray(0, 300).toString('latin1').match(/encoding=["']([\w-]+)["']/i) || [])[1];
  cs = (cs || 'utf-8').toLowerCase();
  try { return new TextDecoder(cs === 'utf8' ? 'utf-8' : cs).decode(buf); } catch { return buf.toString('utf8'); }
}

async function fetchText(url, opts = {}) {
  const r = await fetchRaw(url, opts);
  if (!r.ok) throw new HttpError(r.status, url);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > (opts.maxBytes || 15e6)) throw new Error('response too large');
  return decodeBody(buf, r.headers.get('content-type') || '');
}

async function fetchJSON(url, opts = {}) {
  return JSON.parse(await fetchText(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers || {}) } }));
}

// SSRF guard for user-supplied URLs (custom RSS feeds)
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const l = ip.toLowerCase();
  if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7));
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
}
async function assertPublicUrl(u) {
  const url = new URL(u);
  if (!/^https?:$/.test(url.protocol)) throw new Error('only http(s) URLs are allowed');
  if (ALLOW_PRIVATE_FEEDS) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map(a => a.address);
  if (!addrs.length || addrs.some(isPrivateIp)) throw new Error('private network address blocked');
  return url;
}
async function fetchPublicText(u, opts = {}) {
  let url = u;
  for (let i = 0; i < 4; i++) {
    await assertPublicUrl(url);
    const r = await fetchRaw(url, { ...opts, redirect: 'manual' });
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) { url = new URL(loc, url).href; continue; }
    if (!r.ok) throw new HttpError(r.status, url);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 5e6) throw new Error('response too large');
    return decodeBody(buf, r.headers.get('content-type') || '');
  }
  throw new Error('too many redirects');
}

// ───────────────────────────── Yahoo Finance ─────────────────────────────
const yahoo = { cookie: '', crumb: '', t: 0, pending: null };
async function yahooAuth(force = false) {
  if (!force && yahoo.crumb && Date.now() - yahoo.t < 6 * 3600e3) return yahoo;
  if (yahoo.pending) return yahoo.pending;
  yahoo.pending = (async () => {
    try {
      const r = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
      const cookies = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map(c => c.split(';')[0]).filter(Boolean);
      if (cookies.length) yahoo.cookie = cookies.join('; ');
      const rc = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: yahoo.cookie }, signal: AbortSignal.timeout(10000) });
      const crumb = (await rc.text()).trim();
      if (!rc.ok || !crumb || crumb.length > 40 || /[<\s{]/.test(crumb)) throw new Error('crumb HTTP ' + rc.status);
      yahoo.crumb = crumb;
      yahoo.t = Date.now();
      return yahoo;
    } finally {
      yahoo.pending = null;
    }
  })();
  return yahoo.pending;
}

async function yahooJSON(url, retry = true) {
  const a = await yahooAuth().catch(e => { mark('yahoo', false, 'auth: ' + e.message); return null; });
  const u = a && a.crumb ? url + (url.includes('?') ? '&' : '?') + 'crumb=' + encodeURIComponent(a.crumb) : url;
  const r = await fetch(u, {
    headers: { 'User-Agent': UA, Accept: 'application/json', ...(a && a.cookie ? { Cookie: a.cookie } : {}) },
    signal: AbortSignal.timeout(12000),
  });
  if ((r.status === 401 || r.status === 403 || r.status === 429) && retry) {
    await yahooAuth(true).catch(() => {});
    return yahooJSON(url, false);
  }
  if (!r.ok) throw new HttpError(r.status, url);
  return r.json();
}

const SYM_RE = /^[A-Z0-9^=._\-&]{1,24}$/;
const cleanSymbols = (str, max = 150) =>
  [...new Set(String(str || '').split(',').map(s => s.trim().toUpperCase()).filter(s => SYM_RE.test(s)))].slice(0, max);

function normQuote(q) {
  const price = q.regularMarketPrice;
  const prev = q.regularMarketPreviousClose ?? null;
  return {
    symbol: q.symbol, name: q.shortName || q.longName || q.displayName || q.symbol, longName: q.longName,
    price, prevClose: prev,
    change: q.regularMarketChange ?? (prev != null ? price - prev : null),
    changePct: q.regularMarketChangePercent ?? (prev ? (price / prev - 1) * 100 : null),
    open: q.regularMarketOpen, high: q.regularMarketDayHigh, low: q.regularMarketDayLow,
    volume: q.regularMarketVolume, avgVolume: q.averageDailyVolume3Month, marketCap: q.marketCap,
    currency: q.currency, marketState: q.marketState, time: q.regularMarketTime ? q.regularMarketTime * 1000 : null,
    exchange: q.fullExchangeName || q.exchange, type: q.quoteType, tz: q.exchangeTimezoneName,
    high52: q.fiftyTwoWeekHigh, low52: q.fiftyTwoWeekLow, ma50: q.fiftyDayAverage, ma200: q.twoHundredDayAverage,
    pe: q.trailingPE, fpe: q.forwardPE, eps: q.epsTrailingTwelveMonths, fwdEps: q.epsForward, pb: q.priceToBook, bookValue: q.bookValue,
    divYield: q.dividendYield ?? (q.trailingAnnualDividendYield != null ? q.trailingAnnualDividendYield * 100 : undefined),
    delay: q.exchangeDataDelayedBy, bid: q.bid, ask: q.ask,
    prePrice: q.preMarketPrice, preChangePct: q.preMarketChangePercent,
    postPrice: q.postMarketPrice, postChangePct: q.postMarketChangePercent,
    earningsTs: q.earningsTimestamp ? q.earningsTimestamp * 1000 : undefined,
  };
}

function chartMetaQuote(m) {
  if (!m || m.regularMarketPrice == null) return null;
  const price = m.regularMarketPrice;
  const prev = m.chartPreviousClose ?? m.previousClose ?? null;
  return {
    symbol: m.symbol, name: m.shortName || m.longName || m.symbol, price, prevClose: prev,
    change: prev != null ? price - prev : null,
    changePct: m.regularMarketChangePercent ?? (prev ? (price / prev - 1) * 100 : null),
    high: m.regularMarketDayHigh, low: m.regularMarketDayLow, volume: m.regularMarketVolume,
    currency: m.currency, exchange: m.fullExchangeName || m.exchangeName, type: m.instrumentType,
    high52: m.fiftyTwoWeekHigh, low52: m.fiftyTwoWeekLow,
    time: m.regularMarketTime ? m.regularMarketTime * 1000 : null, tz: m.exchangeTimezoneName,
  };
}

const QUOTE_TTL = 12e3;
const quoteCache = new Map(); // SYM -> { q, t }
const pendingSym = new Map(); // SYM -> Promise
const badSym = new Map();     // SYM -> ts (unknown symbols, retried after 15 min)

async function chartQuote(sym) {
  const j = await yahooJSON(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=5m`);
  return chartMetaQuote(j?.chart?.result?.[0]?.meta);
}

async function fetchQuotesBatch(list) {
  const missing = [];
  await Promise.all(chunk(list, 40).map(async ch => {
    try {
      const j = await yahooJSON(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(ch.join(','))}`);
      const got = new Set();
      for (const q of j?.quoteResponse?.result || []) {
        if (q.regularMarketPrice == null) continue;
        quoteCache.set(q.symbol.toUpperCase(), { q: normQuote(q), t: Date.now() });
        got.add(q.symbol.toUpperCase());
      }
      for (const s of ch) if (!got.has(s)) missing.push(s);
      mark('yahoo', true);
    } catch (e) {
      mark('yahoo', false, 'quote: ' + e.message);
      missing.push(...ch);
    }
  }));
  if (missing.length) {
    await mapLimit(missing, 4, async s => {
      try {
        const q = await chartQuote(s);
        if (q) quoteCache.set(s, { q, t: Date.now() }); else badSym.set(s, Date.now());
      } catch (e) {
        if (e.status === 404) badSym.set(s, Date.now());
      }
    });
  }
}

async function getQuotes(syms) {
  const now = Date.now();
  const out = {}, need = [], waits = [];
  for (const s of syms) {
    const c = quoteCache.get(s);
    if (c && now - c.t < QUOTE_TTL) { out[s] = c.q; continue; }
    if (badSym.has(s) && now - badSym.get(s) < 15 * 60e3) continue;
    if (pendingSym.has(s)) waits.push(pendingSym.get(s));
    else need.push(s);
  }
  if (need.length) {
    const p = fetchQuotesBatch(need).catch(() => {});
    const clean = () => need.forEach(s => { if (pendingSym.get(s) === p) pendingSym.delete(s); });
    p.then(clean, clean);
    need.forEach(s => pendingSym.set(s, p));
    waits.push(p);
  }
  await Promise.all(waits);
  for (const s of syms) {
    if (out[s]) continue;
    const c = quoteCache.get(s);
    if (c) out[s] = Date.now() - c.t > QUOTE_TTL * 6 ? { ...c.q, stale: true } : c.q;
  }
  return out;
}

const RANGES = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max']);
const INTERVALS = new Set(['1m', '2m', '5m', '15m', '30m', '60m', '90m', '1h', '1d', '5d', '1wk', '1mo', '3mo']);

function getChart(sym, range = '1mo', interval = '1d') {
  const intraday = /[mh]$/.test(interval) && interval !== '1mo' && interval !== '3mo';
  return cached(`chart:${sym}:${range}:${interval}`, intraday ? 60e3 : 15 * 60e3, async () => {
    const j = await yahooJSON(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}&includePrePost=false`);
    const res = j?.chart?.result?.[0];
    if (!res) throw new Error(j?.chart?.error?.description || 'no chart data');
    const q = res.indicators?.quote?.[0] || {};
    const ts = res.timestamp || [];
    const out = { symbol: res.meta?.symbol || sym, currency: res.meta?.currency, tz: res.meta?.exchangeTimezoneName, meta: chartMetaQuote(res.meta), t: [], o: [], h: [], l: [], c: [], v: [] };
    for (let i = 0; i < ts.length; i++) {
      const c = q.close?.[i];
      if (c == null) continue;
      out.t.push(ts[i] * 1000);
      out.o.push(q.open?.[i] ?? c);
      out.h.push(q.high?.[i] ?? c);
      out.l.push(q.low?.[i] ?? c);
      out.c.push(c);
      out.v.push(q.volume?.[i] ?? 0);
    }
    mark('yahoo', true);
    return out;
  });
}

async function getSpark(syms, range = '1d', interval = '15m') {
  const out = {}, need = [];
  for (const s of syms) {
    const c = cache.get(`spark:${s}:${range}`);
    if (c && Date.now() - c.t < 5 * 60e3) out[s] = c.v; else need.push(s);
  }
  await Promise.all(chunk(need, 20).map(async ch => {
    try {
      const j = await yahooJSON(`https://query1.finance.yahoo.com/v7/finance/spark?symbols=${encodeURIComponent(ch.join(','))}&range=${range}&interval=${interval}`);
      for (const r of j?.spark?.result || []) {
        const resp = r.response?.[0];
        const closes = (resp?.indicators?.quote?.[0]?.close || []).filter(v => v != null);
        if (!closes.length) continue;
        const v = { c: downsample(closes, 64), prev: resp?.meta?.chartPreviousClose ?? resp?.meta?.previousClose ?? null };
        cache.set(`spark:${r.symbol.toUpperCase()}:${range}`, { v, t: Date.now() });
        out[r.symbol.toUpperCase()] = v;
      }
    } catch (e) {
      mark('yahoo', false, 'spark: ' + e.message);
    }
  }));
  for (const s of syms) if (!out[s]) { const c = cache.get(`spark:${s}:${range}`); if (c) out[s] = c.v; }
  return out;
}

function ySearch(q) {
  return cached('search:' + q.toLowerCase(), 3600e3, async () => {
    const j = await yahooJSON(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&listsCount=0`);
    return (j.quotes || []).filter(x => x.symbol).map(x => ({
      symbol: x.symbol, name: x.shortname || x.longname || x.symbol, exchange: x.exchDisp || x.exchange, type: x.typeDisp || x.quoteType,
    }));
  });
}

// Multi-period performance for a set of symbols (sectors, benchmarks…)
async function getPerf(syms) {
  const quotes = await getQuotes(syms);
  const out = {};
  await mapLimit(syms, 4, async s => {
    const ch = await getChart(s, '1y', '1d').catch(() => null);
    const q = quotes[s];
    if (!ch || !ch.c.length) { if (q) out[s] = { price: q.price, d1: q.changePct, name: q.name }; return; }
    const c = ch.c, last = q?.price ?? c[c.length - 1];
    const back = n => (c.length > n ? c[c.length - 1 - n] : c[0]);
    const r = base => (base ? (last / base - 1) * 100 : null);
    const year = new Date().getUTCFullYear();
    let ytdBase = null;
    for (let i = ch.t.length - 1; i >= 0; i--) { if (new Date(ch.t[i]).getUTCFullYear() < year) { ytdBase = c[i]; break; } }
    out[s] = {
      name: q?.name || s, price: last, currency: q?.currency || ch.currency,
      d1: q?.changePct ?? r(back(1)), w1: r(back(5)), m1: r(back(21)), m3: r(back(63)), m6: r(back(126)), ytd: r(ytdBase ?? c[0]), y1: r(c[0]),
    };
  });
  return out;
}

// Correlation matrix of daily log returns
async function getCorr(syms, days) {
  const charts = await mapLimit(syms, 4, s => getChart(s, '2y', '1d'));
  const series = charts.map(ch => {
    const m = new Map();
    if (ch) for (let i = 0; i < ch.t.length; i++) m.set(isoDate(ch.t[i]), ch.c[i]);
    return m;
  });
  const valid = series.map(m => m.size > 20);
  let dates = null;
  series.forEach((m, i) => { if (!valid[i]) return; const ks = new Set(m.keys()); dates = dates ? dates.filter(d => ks.has(d)) : [...ks]; });
  dates = (dates || []).sort().slice(-(days + 1));
  const rets = series.map((m, i) => {
    if (!valid[i]) return null;
    const out = [];
    for (let k = 1; k < dates.length; k++) out.push(Math.log(m.get(dates[k]) / m.get(dates[k - 1])));
    return out;
  });
  const corr = (a, b) => {
    const n = Math.min(a.length, b.length);
    if (n < 5) return null;
    let sa = 0, sb = 0;
    for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
    const ma = sa / n, mb = sb / n;
    let cov = 0, va = 0, vb = 0;
    for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; cov += x * y; va += x * x; vb += y * y; }
    return va && vb ? cov / Math.sqrt(va * vb) : null;
  };
  const matrix = syms.map((_, i) => syms.map((__, j) => (rets[i] && rets[j] ? (i === j ? 1 : corr(rets[i], rets[j])) : null)));
  const vol = rets.map(r => {
    if (!r || r.length < 5) return null;
    const m = r.reduce((s, x) => s + x, 0) / r.length;
    return Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1)) * Math.sqrt(252) * 100;
  });
  return { symbols: syms, matrix, vol, samples: Math.max(0, dates.length - 1), from: dates[0], to: dates[dates.length - 1] };
}

// ───────────────────────────── Fundamentals (stock analyzer) ─────────────────────────────
const TS_KEY = {
  TotalRevenue: 'revenue', CostOfRevenue: 'cogs', GrossProfit: 'grossProfit', OperatingIncome: 'opIncome', EBIT: 'ebit', EBITDA: 'ebitda',
  NetIncome: 'netIncome', DilutedEPS: 'eps', DilutedAverageShares: 'dilShares', OperatingCashFlow: 'ocf', CapitalExpenditure: 'capex',
  FreeCashFlow: 'fcf', TotalAssets: 'assets', CurrentAssets: 'curAssets', CurrentLiabilities: 'curLiab', TotalLiabilitiesNetMinorityInterest: 'liab',
  StockholdersEquity: 'equity', RetainedEarnings: 'retained', TotalDebt: 'debt', LongTermDebt: 'ltDebt', CashAndCashEquivalents: 'cash',
  CashCashEquivalentsAndShortTermInvestments: 'cashSti', InterestExpense: 'interest', PretaxIncome: 'pretax', TaxProvision: 'tax',
  TaxRateForCalcs: 'taxRate', CashDividendsPaid: 'dividends', RepurchaseOfCapitalStock: 'buybacks', OrdinarySharesNumber: 'shares',
  Inventory: 'inventory', WorkingCapital: 'workingCapital', InvestedCapital: 'investedCapital', NetDebt: 'netDebt',
  ResearchAndDevelopment: 'rnd', StockBasedCompensation: 'sbc',
};
// long-term government bond yield per currency (risk-free rate for discounting)
const RF_SERIES = { USD: 'DGS10', EUR: 'IRLTLT01DEM156N', CZK: 'IRLTLT01CZM156N', GBP: 'IRLTLT01GBM156N', GBp: 'IRLTLT01GBM156N', JPY: 'IRLTLT01JPM156N', CHF: 'IRLTLT01CHM156N', PLN: 'IRLTLT01PLM156N' };
const RF_NAME = { DGS10: 'US 10Y', IRLTLT01DEM156N: 'DE 10Y (Bund)', IRLTLT01CZM156N: 'CZ 10Y', IRLTLT01GBM156N: 'UK 10Y', IRLTLT01JPM156N: 'JP 10Y', IRLTLT01CHM156N: 'CH 10Y', IRLTLT01PLM156N: 'PL 10Y' };
const yraw = v => (v == null ? null : typeof v === 'object' ? (v.raw ?? null) : v);

async function fxFactor(from, to) {
  if (!from || !to || from === to) return 1;
  const fx = await cached('fx', 60e3, getFx).catch(() => null);
  const r = (fx && fx.rates) || {};
  if (r[from] && r[to]) return r[from] / r[to];
  const base = c => (c === 'GBp' || c === 'GBX' ? ['GBP', 0.01] : c === 'ZAc' ? ['ZAR', 0.01] : c === 'ILA' ? ['ILS', 0.01] : c === 'USX' ? ['USD', 0.01] : [c, 1]);
  const [f, fm] = base(from), [t, tm] = base(to);
  if (f === t) return fm / tm;
  const s = `${f}${t}=X`;
  const q = (await getQuotes([s]))[s];
  if (q && q.price) return (q.price * fm) / tm;
  throw new Error(`FX ${from}→${to} nedostupný`);
}

function technicals(ch, rfPct) {
  const { c, h, l, t } = ch, n = c.length;
  if (n < 60) return null;
  const avg = a => a.reduce((s, x) => s + x, 0) / a.length;
  const std = a => { const m = avg(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
  const last = c[n - 1];
  const pre = [0]; for (let i = 0; i < n; i++) pre.push(pre[i] + c[i]);
  const smaAt = (k, i) => (i + 1 >= k ? (pre[i + 1] - pre[i + 1 - k]) / k : null);
  const ema = (arr, k) => { const a = 2 / (k + 1); let e = arr[0]; return arr.map((v, i) => (e = i ? v * a + e * (1 - a) : e)); };
  let g = 0, lo = 0;
  for (let i = 1; i <= 14; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else lo -= d; }
  g /= 14; lo /= 14;
  for (let i = 15; i < n; i++) { const d = c[i] - c[i - 1]; g = (g * 13 + Math.max(d, 0)) / 14; lo = (lo * 13 + Math.max(-d, 0)) / 14; }
  const rsi = lo === 0 ? 100 : 100 - 100 / (1 + g / lo);
  const e12 = ema(c, 12), e26 = ema(c, 26), macdLine = c.map((_, i) => e12[i] - e26[i]);
  const sig = ema(macdLine.slice(26), 9);
  const macd = macdLine[n - 1], signal = sig[sig.length - 1];
  const s20 = c.slice(-20), m20 = avg(s20), sd20 = std(s20);
  let atr = 0;
  for (let i = n - 14; i < n; i++) atr += Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  atr /= 14;
  const hh = Math.max(...h.slice(-14)), ll = Math.min(...l.slice(-14));
  const at = days => { const target = t[n - 1] - days * 864e5; if (t[0] > target + 5 * 864e5) return null; for (let i = n - 1; i >= 0; i--) if (t[i] <= target) return c[i]; return null; };
  const ret = p => (p ? (last / p - 1) * 100 : null);
  const yr = new Date(t[n - 1]).getUTCFullYear();
  let ytdBase = null;
  for (let i = n - 1; i >= 0; i--) if (new Date(t[i]).getUTCFullYear() < yr) { ytdBase = c[i]; break; }
  const i1y = Math.max(1, t.findIndex(x => x >= t[n - 1] - 365 * 864e5));
  const lr = []; for (let i = i1y; i < n; i++) lr.push(Math.log(c[i] / c[i - 1]));
  const vol = std(lr) * Math.sqrt(252) * 100;
  const mdd = from => { let peak = c[from], dd = 0; for (let i = from; i < n; i++) { if (c[i] > peak) peak = c[i]; dd = Math.min(dd, c[i] / peak - 1); } return dd * 100; };
  let cross = null;
  for (let i = n - 1; i > Math.max(200, n - 750); i--) {
    const a = smaAt(50, i) - smaAt(200, i), b = smaAt(50, i - 1) - smaAt(200, i - 1);
    if (a > 0 && b <= 0) { cross = { type: 'golden', ts: t[i] }; break; }
    if (a < 0 && b >= 0) { cross = { type: 'death', ts: t[i] }; break; }
  }
  const y1 = ret(at(365));
  const c1y = c.slice(i1y - 1);
  // chart history (last 3 years, ~250 points) with moving averages
  const from = Math.max(0, t.findIndex(x => x >= t[n - 1] - 3 * 365 * 864e5)), step = Math.max(1, Math.round((n - from) / 260));
  const hist = { t: [], c: [], s50: [], s200: [] };
  for (let i = from; i < n; i += step) { hist.t.push(t[i]); hist.c.push(c[i]); hist.s50.push(smaAt(50, i)); hist.s200.push(smaAt(200, i)); }
  if (hist.t[hist.t.length - 1] !== t[n - 1]) { hist.t.push(t[n - 1]); hist.c.push(last); hist.s50.push(smaAt(50, n - 1)); hist.s200.push(smaAt(200, n - 1)); }
  return {
    last, rsi, macd, macdSignal: signal, macdHist: macd - signal, sma20: smaAt(20, n - 1), sma50: smaAt(50, n - 1), sma100: smaAt(100, n - 1), sma200: smaAt(200, n - 1),
    ema20: ema(c.slice(-120), 20).pop(), bbUpper: m20 + 2 * sd20, bbLower: m20 - 2 * sd20, bbPctB: sd20 ? (last - (m20 - 2 * sd20)) / (4 * sd20) : null,
    atrPct: (atr / last) * 100, stoch: hh > ll ? ((last - ll) / (hh - ll)) * 100 : 50,
    high52: Math.max(...c1y), low52: Math.min(...c1y),
    perf: { w1: ret(at(7)), m1: ret(at(30)), m3: ret(at(91)), m6: ret(at(182)), ytd: ret(ytdBase), y1, y3: ret(at(3 * 365)), y5: ret(at(5 * 365 - 5)) },
    vol1y: vol, mdd1y: mdd(i1y - 1), mdd5y: mdd(0), sharpe1y: vol && y1 != null ? (y1 - (rfPct || 0)) / vol : null, cross, hist,
  };
}

function getFundamentals(sym) {
  return cached('fund:' + sym, 6 * 3600e3, async () => {
    const mods = 'assetProfile,financialData,defaultKeyStatistics,summaryDetail,price,earningsTrend,recommendationTrend,calendarEvents,earningsHistory';
    const p2 = Math.floor(Date.now() / 1000), p1 = p2 - 7 * 365 * 86400;
    const types = Object.keys(TS_KEY).flatMap(k => ['annual' + k, 'trailing' + k]).join(',');
    const [qs, ts, ch, pe] = await Promise.all([
      yahooJSON(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=${mods}`),
      yahooJSON(`https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(sym)}?symbol=${encodeURIComponent(sym)}&type=${types}&period1=${p1}&period2=${p2}`).catch(() => null),
      getChart(sym, '5y', '1d').catch(() => null),
      yahooJSON(`https://query2.finance.yahoo.com/v6/finance/recommendationsbysymbol/${encodeURIComponent(sym)}`).catch(() => null),
    ]);
    const r = qs && qs.quoteSummary && qs.quoteSummary.result && qs.quoteSummary.result[0];
    if (!r) throw Object.assign(new Error((qs && qs.quoteSummary && qs.quoteSummary.error && qs.quoteSummary.error.description) || 'fundamentální data nejsou k dispozici'), { status: 404 });
    const fd = r.financialData || {}, ks = r.defaultKeyStatistics || {}, sd = r.summaryDetail || {}, pr = r.price || {}, ap = r.assetProfile || {};
    // statements
    const annualMap = {}, ttm = {}, ttmPrev = {};
    for (const x of (ts && ts.timeseries && ts.timeseries.result) || []) {
      const typ = x.meta && x.meta.type && x.meta.type[0];
      const m = typ && typ.match(/^(annual|trailing)(.+)$/);
      const key = m && TS_KEY[m[2]];
      if (!key) continue;
      const arr = (x[typ] || []).filter(v => v && v.reportedValue && v.reportedValue.raw != null).sort((a, b) => a.asOfDate.localeCompare(b.asOfDate));
      if (!arr.length) continue;
      if (m[1] === 'annual') { for (const v of arr) (annualMap[v.asOfDate] = annualMap[v.asOfDate] || { date: v.asOfDate })[key] = v.reportedValue.raw; }
      else {
        const lastV = arr[arr.length - 1];
        ttm[key] = lastV.reportedValue.raw; ttm.date = ttm.date && ttm.date > lastV.asOfDate ? ttm.date : lastV.asOfDate;
        const cutoff = isoDate(Date.parse(lastV.asOfDate) - 300 * 864e5);
        const prev = arr.filter(v => v.asOfDate <= cutoff).pop();
        if (prev) ttmPrev[key] = prev.reportedValue.raw;
      }
    }
    const annual = Object.values(annualMap).sort((a, b) => a.date.localeCompare(b.date)).filter(a => a.revenue != null || a.netIncome != null || a.assets != null);
    const price = yraw(fd.currentPrice) ?? yraw(pr.regularMarketPrice);
    const currency = pr.currency || sd.currency;
    const finCur = fd.financialCurrency || currency;
    let fx = 1, fxErr = null;
    try { fx = await fxFactor(finCur, currency); } catch (e) { fxErr = e.message; }
    const rfId = RF_SERIES[currency] || 'DGS10';
    const [rfS, aaaS] = await Promise.all([fred(rfId, isoDate(Date.now() - 500 * 864e5)).catch(() => null), fred('DAAA', isoDate(Date.now() - 120 * 864e5)).catch(() => null)]);
    const rf = rfS ? rfS[rfS.length - 1][1] : 4.2;
    const trend = ((r.earningsTrend && r.earningsTrend.trend) || []).map(x => ({
      period: x.period, end: x.endDate, growth: yraw(x.growth),
      eps: yraw(x.earningsEstimate && x.earningsEstimate.avg), epsLow: yraw(x.earningsEstimate && x.earningsEstimate.low), epsHigh: yraw(x.earningsEstimate && x.earningsEstimate.high),
      epsYearAgo: yraw(x.earningsEstimate && x.earningsEstimate.yearAgoEps), epsAnalysts: yraw(x.earningsEstimate && x.earningsEstimate.numberOfAnalysts),
      rev: yraw(x.revenueEstimate && x.revenueEstimate.avg), revGrowth: yraw(x.revenueEstimate && x.revenueEstimate.growth),
    }));
    const cal = r.calendarEvents || {};
    const out = {
      symbol: pr.symbol || sym, name: pr.shortName || pr.longName || sym, longName: pr.longName, type: pr.quoteType, exchange: pr.exchangeName, exchangeName: pr.exchange,
      currency, finCur, fx, fxErr, price, change: yraw(pr.regularMarketChange), changePct: yraw(pr.regularMarketChangePercent) != null ? yraw(pr.regularMarketChangePercent) * 100 : null,
      marketState: pr.marketState, marketCap: yraw(pr.marketCap) ?? yraw(sd.marketCap),
      profile: { sector: ap.sector, industry: ap.industry, country: ap.country, city: ap.city, employees: ap.fullTimeEmployees, website: ap.website, summary: (ap.longBusinessSummary || '').slice(0, 1600) },
      stats: {
        pe: yraw(sd.trailingPE), fpe: yraw(sd.forwardPE) ?? yraw(ks.forwardPE), peg: yraw(ks.pegRatio) ?? yraw(ks.trailingPegRatio), pb: yraw(ks.priceToBook), ps: yraw(sd.priceToSalesTrailing12Months),
        ev: yraw(ks.enterpriseValue), evEbitda: yraw(ks.enterpriseToEbitda), evRevenue: yraw(ks.enterpriseToRevenue), bookValue: yraw(ks.bookValue),
        trailingEps: yraw(ks.trailingEps), forwardEps: yraw(ks.forwardEps), beta: yraw(ks.beta) ?? yraw(sd.beta), shares: yraw(ks.sharesOutstanding), floatShares: yraw(ks.floatShares),
        dividendRate: yraw(sd.dividendRate) ?? yraw(sd.trailingAnnualDividendRate), dividendYield: yraw(sd.dividendYield) != null ? yraw(sd.dividendYield) * 100 : null,
        payoutRatio: yraw(sd.payoutRatio) != null ? yraw(sd.payoutRatio) * 100 : null, divYield5y: yraw(sd.fiveYearAvgDividendYield), exDivDate: yraw(sd.exDividendDate) ? yraw(sd.exDividendDate) * 1000 : null,
        shortPctFloat: yraw(ks.shortPercentOfFloat) != null ? yraw(ks.shortPercentOfFloat) * 100 : null, shortRatio: yraw(ks.shortRatio),
        insiders: yraw(ks.heldPercentInsiders) != null ? yraw(ks.heldPercentInsiders) * 100 : null, institutions: yraw(ks.heldPercentInstitutions) != null ? yraw(ks.heldPercentInstitutions) * 100 : null,
        w52change: yraw(ks['52WeekChange']) != null ? yraw(ks['52WeekChange']) * 100 : null, sp52change: yraw(ks.SandP52WeekChange) != null ? yraw(ks.SandP52WeekChange) * 100 : null,
        high52: yraw(sd.fiftyTwoWeekHigh), low52: yraw(sd.fiftyTwoWeekLow), allTimeHigh: yraw(sd.allTimeHigh), avgVolume: yraw(sd.averageVolume),
        lastFiscalYearEnd: yraw(ks.lastFiscalYearEnd) ? yraw(ks.lastFiscalYearEnd) * 1000 : null, mostRecentQuarter: yraw(ks.mostRecentQuarter) ? yraw(ks.mostRecentQuarter) * 1000 : null,
      },
      fin: {
        targetMean: yraw(fd.targetMeanPrice), targetMedian: yraw(fd.targetMedianPrice), targetHigh: yraw(fd.targetHighPrice), targetLow: yraw(fd.targetLowPrice),
        recMean: yraw(fd.recommendationMean), recKey: fd.recommendationKey, analysts: yraw(fd.numberOfAnalystOpinions),
        cash: yraw(fd.totalCash), debt: yraw(fd.totalDebt), ebitda: yraw(fd.ebitda), revenue: yraw(fd.totalRevenue), grossProfit: yraw(fd.grossProfits),
        fcf: yraw(fd.freeCashflow), ocf: yraw(fd.operatingCashflow), currentRatio: yraw(fd.currentRatio), quickRatio: yraw(fd.quickRatio), debtToEquity: yraw(fd.debtToEquity),
        roa: yraw(fd.returnOnAssets), roe: yraw(fd.returnOnEquity), grossMargin: yraw(fd.grossMargins), opMargin: yraw(fd.operatingMargins), netMargin: yraw(fd.profitMargins),
        ebitdaMargin: yraw(fd.ebitdaMargins), revenueGrowth: yraw(fd.revenueGrowth), earningsGrowth: yraw(fd.earningsGrowth),
      },
      trend,
      recs: ((r.recommendationTrend && r.recommendationTrend.trend) || []).map(x => ({ period: x.period, strongBuy: x.strongBuy, buy: x.buy, hold: x.hold, sell: x.sell, strongSell: x.strongSell })),
      earnings: {
        next: ((cal.earnings && cal.earnings.earningsDate) || []).map(d => yraw(d) * 1000).filter(Boolean)[0] || null,
        epsEstimate: yraw(cal.earnings && cal.earnings.earningsAverage), revEstimate: yraw(cal.earnings && cal.earnings.revenueAverage),
        history: ((r.earningsHistory && r.earningsHistory.history) || []).map(x => ({ q: yraw(x.quarter) ? yraw(x.quarter) * 1000 : null, period: x.period, actual: yraw(x.epsActual), estimate: yraw(x.epsEstimate), surprise: yraw(x.surprisePercent) != null ? yraw(x.surprisePercent) * 100 : null })),
      },
      annual, ttm, ttmPrev,
      rf: { rate: rf, series: rfId, name: RF_NAME[rfId] || rfId, date: rfS ? rfS[rfS.length - 1][0] : null },
      aaa: aaaS ? aaaS[aaaS.length - 1][1] : null,
      tech: ch && ch.c.length ? technicals(ch, rf) : null,
      peers: (((pe && pe.finance && pe.finance.result && pe.finance.result[0] && pe.finance.result[0].recommendedSymbols) || []).map(x => x.symbol)).slice(0, 8),
      updated: Date.now(),
    };
    mark('yahoo', true);
    return out;
  });
}

// ───────────────────────────── FX (ČNB + live) ─────────────────────────────
function getCnbFx() {
  return cached('cnb:fx', 3600e3, async () => {
    const txt = await fetchText('https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/denni_kurz.txt');
    const lines = txt.trim().split(/\r?\n/);
    const d = lines[0].match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    const rates = { CZK: 1 }, names = { CZK: 'Česko – koruna' };
    for (const ln of lines.slice(2)) {
      const p = ln.split('|');
      if (p.length < 5) continue;
      const amt = num(p[2]), rate = num(p[4]);
      if (amt && rate) { rates[p[3]] = rate / amt; names[p[3]] = `${p[0]} – ${p[1]}`; }
    }
    mark('cnb', true);
    return { date: d ? `${d[3]}-${d[2].padStart(2, '0')}-${d[1].padStart(2, '0')}` : null, rates, names };
  });
}

async function getFx() {
  const cnb = await getCnbFx().catch(e => { mark('cnb', false, e.message); return { rates: { CZK: 1 }, names: {}, date: null }; });
  const liveMap = { 'CZK=X': 'USD', 'EURCZK=X': 'EUR', 'GBPCZK=X': 'GBP', 'CHFCZK=X': 'CHF', 'JPYCZK=X': 'JPY', 'PLNCZK=X': 'PLN' };
  const live = await getQuotes(Object.keys(liveMap)).catch(() => ({}));
  const rates = { ...cnb.rates }, liveList = [];
  for (const [s, c] of Object.entries(liveMap)) if (live[s]?.price) { rates[c] = live[s].price; liveList.push(c); }
  if (rates.GBP) rates.GBp = rates.GBX = rates.GBP / 100;
  if (rates.USD) rates.USX = rates.USD / 100;
  if (rates.ZAR) rates.ZAc = rates.ZAR / 100;
  if (rates.ILS) rates.ILA = rates.ILS / 100;
  return { base: 'CZK', date: cnb.date, rates, live: liveList, names: cnb.names };
}

function getCnbRepo() {
  return cached('cnb:repo', 12 * 3600e3, async () => {
    const txt = await fetchText('https://www.cnb.cz/cs/casto-kladene-dotazy/.galleries/vyvoj_repo_historie.txt');
    const rows = [];
    for (const ln of txt.trim().split(/\r?\n/).slice(1)) {
      const [d, v] = ln.split('|');
      const n = num(v);
      if (/^\d{8}$/.test(d || '') && n != null) rows.push([`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, n]);
    }
    if (!rows.length) throw new Error('empty repo history');
    mark('cnb', true);
    return rows;
  });
}

// ───────────────────────────── FRED macro ─────────────────────────────
function fred(id, from = '2018-01-01') {
  if (!/^[A-Z0-9_]{2,40}$/i.test(id)) return Promise.reject(new Error('bad series id'));
  const daily = /^(DGS|T10Y|BAML|SOFR|DFEDTAR|ECBDFR|T5YIE|T10YIE|VIXCLS|DCOIL|DEX)/.test(id);
  return cached(`fred:${id}:${from}`, (daily ? 3 : 8) * 3600e3, async () => {
    const txt = await fetchText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${from}`, { timeout: 25000 });
    const out = [];
    for (const ln of txt.trim().split(/\r?\n/).slice(1)) {
      const i = ln.indexOf(',');
      const v = parseFloat(ln.slice(i + 1));
      if (i > 0 && Number.isFinite(v)) out.push([ln.slice(0, i), v]);
    }
    if (!out.length) throw new Error('empty series ' + id);
    mark('fred', true);
    return out;
  });
}

function transform(series, tf) {
  if (!tf || tf === 'level') return series;
  if (tf === 'yoy') {
    const m = new Map(series), out = [];
    for (const [d, v] of series) { const p = m.get(`${+d.slice(0, 4) - 1}${d.slice(4)}`); if (p) out.push([d, (v / p - 1) * 100]); }
    return out;
  }
  if (tf === 'mom') return series.slice(1).map(([d, v], i) => [d, (v / series[i][1] - 1) * 100]);
  if (tf === 'diff') return series.slice(1).map(([d, v], i) => [d, v - series[i][1]]);
  return series;
}

// good: 'up' = rising value is positive for the economy/markets, 'down' = rising is negative
const MACRO = [
  { g: 'Inflace', key: 'us_cpi', label: 'US CPI y/y', fred: 'CPIAUCSL', tf: 'yoy', unit: '%', f: 'm', good: 'down' },
  { g: 'Inflace', key: 'us_core_cpi', label: 'US Core CPI y/y', fred: 'CPILFESL', tf: 'yoy', unit: '%', f: 'm', good: 'down' },
  { g: 'Inflace', key: 'us_core_pce', label: 'US Core PCE y/y', fred: 'PCEPILFE', tf: 'yoy', unit: '%', f: 'm', good: 'down' },
  { g: 'Inflace', key: 'us_ppi', label: 'US PPI y/y', fred: 'PPIACO', tf: 'yoy', unit: '%', f: 'm', good: 'down' },
  { g: 'Inflace', key: 'be10', label: '10Y breakeven inflace', fred: 'T10YIE', unit: '%', f: 'd', good: 'down' },
  { g: 'Inflace', key: 'ez_hicp', label: 'Eurozóna HICP y/y', fred: 'CP0000EZ19M086NEST', tf: 'yoy', unit: '%', f: 'm', good: 'down' },
  { g: 'Inflace', key: 'cz_hicp', label: 'ČR HICP y/y', fred: 'CP0000CZM086NEST', tf: 'yoy', unit: '%', f: 'm', good: 'down' },
  { g: 'Trh práce', key: 'us_nfp', label: 'Nonfarm Payrolls m/m', fred: 'PAYEMS', tf: 'diff', unit: 'tis.', f: 'm', good: 'up', dec: 0 },
  { g: 'Trh práce', key: 'us_unrate', label: 'US nezaměstnanost', fred: 'UNRATE', unit: '%', f: 'm', good: 'down', dec: 1 },
  { g: 'Trh práce', key: 'us_claims', label: 'Initial Jobless Claims', fred: 'ICSA', unit: 'tis.', scale: 1e-3, f: 'w', good: 'down', dec: 0 },
  { g: 'Trh práce', key: 'us_jolts', label: 'JOLTS volná místa', fred: 'JTSJOL', unit: 'mil.', scale: 1e-3, f: 'm', good: 'up' },
  { g: 'Trh práce', key: 'us_wages', label: 'Hodinová mzda y/y', fred: 'CES0500000003', tf: 'yoy', unit: '%', f: 'm' },
  { g: 'Trh práce', key: 'cz_unemp', label: 'ČR nezaměstnanost', fred: 'LRHUTTTTCZM156S', unit: '%', f: 'm', good: 'down', dec: 1 },
  { g: 'Růst', key: 'us_gdp', label: 'US HDP q/q (anualiz.)', fred: 'A191RL1Q225SBEA', unit: '%', f: 'q', good: 'up', dec: 1 },
  { g: 'Růst', key: 'cz_gdp', label: 'ČR HDP y/y (reálně)', fred: 'CLVMNACSCAB1GQCZ', tf: 'yoy', unit: '%', f: 'q', good: 'up', dec: 1 },
  { g: 'Růst', key: 'us_retail', label: 'Maloobchod m/m', fred: 'RSAFS', tf: 'mom', unit: '%', f: 'm', good: 'up' },
  { g: 'Růst', key: 'us_indpro', label: 'Průmyslová výroba y/y', fred: 'INDPRO', tf: 'yoy', unit: '%', f: 'm', good: 'up' },
  { g: 'Růst', key: 'us_houst', label: 'Housing Starts', fred: 'HOUST', unit: 'tis.', f: 'm', good: 'up', dec: 0 },
  { g: 'Růst', key: 'us_umich', label: 'UMich sentiment', fred: 'UMCSENT', unit: '', f: 'm', good: 'up', dec: 1 },
  { g: 'Sazby', key: 'fed', label: 'Fed Funds (horní mez)', fred: 'DFEDTARU', unit: '%', f: 'd' },
  { g: 'Sazby', key: 'ecb', label: 'ECB depozitní sazba', fred: 'ECBDFR', unit: '%', f: 'd' },
  { g: 'Sazby', key: 'cnb', label: 'ČNB 2T repo', src: 'cnb', unit: '%', f: 'd' },
  { g: 'Sazby', key: 'sofr', label: 'SOFR', fred: 'SOFR', unit: '%', f: 'd' },
  { g: 'Sazby', key: 'us2y', label: 'US 2Y výnos', fred: 'DGS2', unit: '%', f: 'd' },
  { g: 'Sazby', key: 'us10y', label: 'US 10Y výnos', fred: 'DGS10', unit: '%', f: 'd' },
  { g: 'Sazby', key: 't10y2y', label: 'Spread 10Y–2Y', fred: 'T10Y2Y', unit: 'p.b.', f: 'd', good: 'up' },
  { g: 'Sazby', key: 't10y3m', label: 'Spread 10Y–3M', fred: 'T10Y3M', unit: 'p.b.', f: 'd', good: 'up' },
  { g: 'Sazby', key: 'mort30', label: 'US hypotéka 30Y', fred: 'MORTGAGE30US', unit: '%', f: 'w', good: 'down' },
  { g: 'Úvěr & likvidita', key: 'hy', label: 'High-yield spread', fred: 'BAMLH0A0HYM2', unit: 'p.b.', f: 'd', good: 'down' },
  { g: 'Úvěr & likvidita', key: 'ig', label: 'IG spread', fred: 'BAMLC0A0CM', unit: 'p.b.', f: 'd', good: 'down' },
  { g: 'Úvěr & likvidita', key: 'm2', label: 'M2 y/y', fred: 'M2SL', tf: 'yoy', unit: '%', f: 'm', good: 'up' },
  { g: 'Úvěr & likvidita', key: 'walcl', label: 'Bilance Fedu', fred: 'WALCL', unit: 'bil. $', scale: 1e-6, f: 'w' },
];

async function macroSeries(m, from = '2018-01-01') {
  let s = m.src === 'cnb' ? (await getCnbRepo()).filter(r => r[0] >= from) : transform(await fred(m.fred, from), m.tf);
  if (m.scale) s = s.map(([d, v]) => [d, v * m.scale]);
  return s;
}

function getMacro() {
  return cached('macro', 20 * 60e3, async () => {
    const rows = await mapLimit(MACRO, 8, async m => {
      try {
        let s = await macroSeries(m);
        if (m.src === 'cnb') s = [...(await getCnbRepo()).filter(r => r[0] < '2018-01-01').slice(-1), ...s];
        if (!s.length) throw new Error('empty');
        const last = s[s.length - 1];
        let prev = s[s.length - 2];
        if (m.f === 'd') { // compare daily series with value ~1 month ago
          const target = isoDate(Date.parse(last[0]) - 30 * 864e5);
          for (let i = s.length - 1; i >= 0; i--) if (s[i][0] <= target) { prev = s[i]; break; }
        }
        const n = { d: 260, w: 104, m: 36, q: 20 }[m.f] || 36;
        const tail = s.slice(-n).map(x => +x[1].toFixed(4));
        return { key: m.key, group: m.g, label: m.label, unit: m.unit, dec: m.dec ?? 2, good: m.good || null, freq: m.f, fred: m.fred || null, tf: m.tf || 'level',
          value: last[1], date: last[0], prev: prev ? prev[1] : null, prevDate: prev ? prev[0] : null, spark: downsample(tail, 60) };
      } catch (e) {
        return { key: m.key, group: m.g, label: m.label, unit: m.unit, error: e.message };
      }
    });
    if (rows.every(r => r.error)) throw new Error('macro unavailable');
    return rows;
  });
}

const CURVE = [['1M', 'DGS1MO'], ['3M', 'DGS3MO'], ['6M', 'DGS6MO'], ['1Y', 'DGS1'], ['2Y', 'DGS2'], ['3Y', 'DGS3'], ['5Y', 'DGS5'], ['7Y', 'DGS7'], ['10Y', 'DGS10'], ['20Y', 'DGS20'], ['30Y', 'DGS30']];
function getCurve() {
  return cached('curve', 3 * 3600e3, async () => {
    const from = isoDate(Date.now() - 420 * 864e5);
    const data = await mapLimit(CURVE, 6, ([, id]) => fred(id, from));
    const ref = data[8] || data.find(Boolean);
    if (!ref) throw new Error('curve unavailable');
    const lastDate = ref[ref.length - 1][0];
    const pick = (s, daysAgo) => {
      if (!s || !s.length) return null;
      const target = isoDate(Date.parse(lastDate) - daysAgo * 864e5);
      for (let i = s.length - 1; i >= 0; i--) if (s[i][0] <= target) return s[i][1];
      return null;
    };
    return { date: lastDate, tenors: CURVE.map(([t], i) => ({ tenor: t, now: pick(data[i], 0), w1: pick(data[i], 7), m1: pick(data[i], 30), y1: pick(data[i], 365) })) };
  });
}

// ───────────────────────────── Central banks ─────────────────────────────
// Decision timestamps (local exchange offsets). Verify yearly: federalreserve.gov, ecb.europa.eu, cnb.cz, bankofengland.co.uk, boj.or.jp
const CB_INFO = {
  FED: { name: 'FED (FOMC)', cur: 'USD' },
  ECB: { name: 'ECB', cur: 'EUR' },
  CNB: { name: 'ČNB', cur: 'CZK' },
  BOE: { name: 'Bank of England', cur: 'GBP' },
  BOJ: { name: 'Bank of Japan', cur: 'JPY' },
};
const CB_MEETINGS = {
  FED: ['2026-01-28T14:00:00-05:00', '2026-03-18T14:00:00-04:00', '2026-04-29T14:00:00-04:00', '2026-06-17T14:00:00-04:00',
    '2026-07-29T14:00:00-04:00', '2026-09-16T14:00:00-04:00', '2026-10-28T14:00:00-04:00', '2026-12-09T14:00:00-05:00',
    '2027-01-27T14:00:00-05:00', '2027-03-17T14:00:00-04:00', '2027-04-28T14:00:00-04:00', '2027-06-09T14:00:00-04:00',
    '2027-07-28T14:00:00-04:00', '2027-09-15T14:00:00-04:00', '2027-10-27T14:00:00-04:00', '2027-12-08T14:00:00-05:00'],
  ECB: ['2026-02-05T14:15:00+01:00', '2026-03-19T14:15:00+01:00', '2026-04-30T14:15:00+02:00', '2026-06-11T14:15:00+02:00',
    '2026-07-23T14:15:00+02:00', '2026-09-10T14:15:00+02:00', '2026-10-29T14:15:00+01:00', '2026-12-17T14:15:00+01:00',
    '2027-02-04T14:15:00+01:00', '2027-03-18T14:15:00+01:00', '2027-04-29T14:15:00+02:00', '2027-06-10T14:15:00+02:00',
    '2027-07-22T14:15:00+02:00', '2027-09-09T14:15:00+02:00', '2027-10-28T14:15:00+02:00', '2027-12-16T14:15:00+01:00'],
  CNB: ['2026-02-05T14:30:00+01:00', '2026-03-19T14:30:00+01:00', '2026-05-07T14:30:00+02:00', '2026-06-18T14:30:00+02:00',
    '2026-08-06T14:30:00+02:00', '2026-09-17T14:30:00+02:00', '2026-11-05T14:30:00+01:00', '2026-12-17T14:30:00+01:00'],
  BOE: ['2026-11-05T12:00:00+00:00', '2026-12-17T12:00:00+00:00'],
  BOJ: ['2026-10-30T12:00:00+09:00', '2026-12-18T12:00:00+09:00'],
};

function lastChange(series) {
  if (!series || !series.length) return null;
  const v = series[series.length - 1][1];
  for (let i = series.length - 2; i >= 0; i--) if (series[i][1] !== v) return { date: series[i + 1][0], from: series[i][1] };
  return null;
}

function getCentralBanks() {
  return cached('cb', 60 * 60e3, async () => {
    const now = Date.now();
    const [fu, fl, ecb, cnb] = await Promise.all([
      fred('DFEDTARU', '2015-01-01').catch(() => null), fred('DFEDTARL', '2015-01-01').catch(() => null),
      fred('ECBDFR', '2015-01-01').catch(() => null), getCnbRepo().catch(() => null),
    ]);
    const next = bank => (CB_MEETINGS[bank] || []).map(Date.parse).filter(t => t > now - 3 * 3600e3).slice(0, 4);
    const monthly = s => { if (!s) return []; const m = new Map(); for (const [d, v] of s) m.set(d.slice(0, 7), v); return [...m].map(([d, v]) => [d + '-01', v]).slice(-120); };
    const cnbSeries = cnb ? (() => { const out = []; let j = 0, cur = null; const start = new Date('2016-01-01'); for (let d = new Date(start); d <= new Date(); d.setMonth(d.getMonth() + 1)) { const ds = isoDate(d); while (j < cnb.length && cnb[j][0] <= ds) cur = cnb[j++][1]; if (cur != null) out.push([ds, cur]); } return out; })() : [];
    const res = [
      { bank: 'FED', ...CB_INFO.FED, rate: fu ? fu[fu.length - 1][1] : null, rateLow: fl ? fl[fl.length - 1][1] : null, last: lastChange(fu), history: monthly(fu), next: next('FED'), src: 'FRED DFEDTARL/DFEDTARU' },
      { bank: 'ECB', ...CB_INFO.ECB, rate: ecb ? ecb[ecb.length - 1][1] : null, last: lastChange(ecb), history: monthly(ecb), next: next('ECB'), src: 'FRED ECBDFR (depozitní sazba)' },
      { bank: 'CNB', ...CB_INFO.CNB, rate: cnb ? cnb[cnb.length - 1][1] : null, last: lastChange(cnb), history: cnbSeries.slice(-120), next: next('CNB'), src: 'cnb.cz – 2T repo sazba' },
      { bank: 'BOE', ...CB_INFO.BOE, rate: null, next: next('BOE'), src: 'termíny: bankofengland.co.uk' },
      { bank: 'BOJ', ...CB_INFO.BOJ, rate: null, next: next('BOJ'), src: 'termíny: boj.or.jp (orientační)' },
    ];
    return res;
  });
}

// ───────────────────────────── Economic calendar ─────────────────────────────
const ARCHIVE_FILE = path.join(DATA_DIR, 'calendar-archive.json');
let archive = { events: {} };
function loadArchive() {
  try { archive = JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8')); if (!archive.events) archive = { events: {} }; } catch { archive = { events: {} }; }
}
function saveArchive() {
  const cutoff = Date.now() - 500 * 864e5;
  for (const [k, e] of Object.entries(archive.events)) if (e.ts < cutoff) delete archive.events[k];
  writeJSONAtomic(ARCHIVE_FILE, archive);
}

function getFF() {
  return cached('ff', 30 * 60e3, async () => {
    const arr = await fetchJSON('https://nfs.faireconomy.media/ff_calendar_thisweek.json', { timeout: 20000 });
    if (!Array.isArray(arr)) throw new Error('unexpected ForexFactory payload');
    const evs = arr.map(e => ({
      id: hash(`${e.date}|${e.country}|${e.title}`), ts: Date.parse(e.date), country: e.country, title: e.title,
      impact: e.impact, forecast: e.forecast || '', previous: e.previous || '', actual: e.actual || '', src: 'ff',
    })).filter(e => e.ts);
    for (const e of evs) {
      const old = archive.events[e.id];
      archive.events[e.id] = old ? { ...old, ...e, actual: e.actual || old.actual || '' } : e;
    }
    saveArchive();
    mark('ff', true);
    return evs;
  });
}

function deriveActuals(list) {
  const groups = new Map();
  for (const e of list) {
    if (e.impact === 'Holiday' || e.src !== 'ff') continue;
    const k = e.country + '|' + e.title;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  for (const g of groups.values()) {
    g.sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < g.length - 1; i++) if (!g[i].actual && g[i + 1].previous) { g[i].actual = g[i + 1].previous; g[i].derived = true; }
  }
  return list;
}

async function getCalendar() {
  let ff = [];
  try { ff = await getFF(); } catch (e) { mark('ff', false, e.message); }
  const now = Date.now(), since = now - 180 * 864e5;
  const all = new Map();
  for (const e of Object.values(archive.events)) if (e.ts >= since) all.set(e.id, { ...e });
  for (const e of ff) all.set(e.id, { ...(all.get(e.id) || {}), ...e });
  const list = deriveActuals([...all.values()]);
  for (const [bank, dates] of Object.entries(CB_MEETINGS)) {
    for (const d of dates) {
      const ts = Date.parse(d);
      if (ts < since) continue;
      const cur = CB_INFO[bank].cur;
      const dup = list.some(e => e.src === 'ff' && e.country === cur && Math.abs(e.ts - ts) < 5 * 3600e3 && /rate|statement|policy|monetary/i.test(e.title));
      if (dup) continue;
      list.push({ id: hash(bank + d), ts, country: cur, title: `${CB_INFO[bank].name} – rozhodnutí o sazbách`, impact: 'High', forecast: '', previous: '', actual: '', src: 'cb', bank, approx: bank === 'BOJ' });
    }
  }
  list.sort((a, b) => a.ts - b.ts);
  return { events: list, updated: health.ff?.lastOk || null, weekCount: ff.length, archiveCount: Object.keys(archive.events).length };
}

// ───────────────────────────── Crypto & sentiment ─────────────────────────────
function getCryptoMarkets() {
  return cached('cg:markets', 3 * 60e3, async () => {
    const arr = await fetchJSON('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=true&price_change_percentage=1h,24h,7d', { timeout: 20000 });
    mark('coingecko', true);
    return arr.map(c => ({
      id: c.id, symbol: (c.symbol || '').toUpperCase(), name: c.name, image: c.image, rank: c.market_cap_rank,
      price: c.current_price, mcap: c.market_cap, vol: c.total_volume, high: c.high_24h, low: c.low_24h,
      ch1h: c.price_change_percentage_1h_in_currency, ch24h: c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h,
      ch7d: c.price_change_percentage_7d_in_currency, ath: c.ath, athPct: c.ath_change_percentage,
      supply: c.circulating_supply, maxSupply: c.max_supply,
      spark: downsample((c.sparkline_in_7d?.price || []).map(v => +v.toPrecision(6)), 42),
    }));
  });
}

async function getCryptoGlobal() {
  const [g, fng] = await Promise.all([
    cached('cg:global', 5 * 60e3, async () => { const j = await fetchJSON('https://api.coingecko.com/api/v3/global'); mark('coingecko', true); return j.data; }).catch(e => { mark('coingecko', false, e.message); return null; }),
    cached('fng:crypto', 30 * 60e3, () => fetchJSON('https://api.alternative.me/fng/?limit=60')).catch(() => null),
  ]);
  return {
    mcap: g?.total_market_cap?.usd ?? null, vol: g?.total_volume?.usd ?? null, mcapChange24h: g?.market_cap_change_percentage_24h_usd ?? null,
    btcD: g?.market_cap_percentage?.btc ?? null, ethD: g?.market_cap_percentage?.eth ?? null,
    usdtD: g?.market_cap_percentage?.usdt ?? null, usdcD: g?.market_cap_percentage?.usdc ?? null, dominance: g?.market_cap_percentage || null,
    coins: g?.active_cryptocurrencies ?? null,
    fng: fng?.data ? { value: +fng.data[0].value, label: fng.data[0].value_classification, history: fng.data.map(d => [d.timestamp * 1000, +d.value]).reverse() } : null,
  };
}

function getStockFng() {
  return cached('fng:stocks', 30 * 60e3, async () => {
    const j = await fetchJSON('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', { headers: { Referer: 'https://edition.cnn.com/', Origin: 'https://edition.cnn.com' } });
    const f = j.fear_and_greed || {};
    mark('cnn', true);
    return {
      value: f.score, label: f.rating, prevClose: f.previous_close, week: f.previous_1_week, month: f.previous_1_month, year: f.previous_1_year, ts: f.timestamp,
      history: downsample((j.fear_and_greed_historical?.data || []).map(p => [p.x, +p.y.toFixed(1)]), 180),
    };
  });
}

function mempoolBase() {
  const s = state.settings?.mempoolUrl;
  return (s && /^https?:\/\//.test(s) ? s : mempoolLocal || MEMPOOL_DEFAULT).replace(/\/+$/, '');
}
function getMempool() {
  const base = mempoolBase();
  return cached('mempool:' + base, 30e3, async () => {
    const get = p => fetchJSON(base + p, { timeout: 12000 });
    const [fees, height, diff, mp, hr, blocks] = await Promise.allSettled([
      get('/api/v1/fees/recommended'), fetchText(base + '/api/blocks/tip/height', { timeout: 12000 }), get('/api/v1/difficulty-adjustment'),
      get('/api/mempool'), get('/api/v1/mining/hashrate/3d'), get('/api/v1/blocks'),
    ]);
    const ok = r => (r.status === 'fulfilled' ? r.value : null);
    if (!ok(fees) && !ok(height)) { mark('mempool', false, fees.reason?.message); throw new Error('mempool unavailable'); }
    mark('mempool', true);
    const m = ok(mp);
    return {
      base, local: base === mempoolLocal || !/mempool\.space/.test(base), fees: ok(fees), height: ok(height) ? parseInt(ok(height), 10) : null, difficulty: ok(diff),
      mempool: m ? { count: m.count, vsize: m.vsize, totalFee: m.total_fee } : null,
      hashrate: ok(hr) ? { current: ok(hr).currentHashrate, difficulty: ok(hr).currentDifficulty } : null,
      blocks: (ok(blocks) || []).slice(0, 8).map(b => ({ height: b.height, ts: b.timestamp * 1000, tx: b.tx_count, size: b.size, pool: b.extras?.pool?.name, medianFee: b.extras?.medianFee, reward: b.extras?.reward })),
    };
  });
}

// ───────────────────────────── News (RSS) ─────────────────────────────
const CNBC = id => `https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=${id}`;
const NYT = s => `https://rss.nytimes.com/services/xml/rss/nyt/${s}.xml`;
// region: cz = české zdroje, us = americké, world = světové/globální
// cat:    macro = Makro & geopolitika, markets = Trhy, firmy & earnings, crypto = Krypto & regulace
const FEEDS = [
  // ── Svět ──
  { id: 'bbc-world', name: 'BBC World', region: 'world', cat: 'macro', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { id: 'aljazeera', name: 'Al Jazeera', region: 'world', cat: 'macro', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { id: 'guardian-world', name: 'Guardian', region: 'world', cat: 'macro', url: 'https://www.theguardian.com/world/rss' },
  { id: 'ft', name: 'Financial Times', region: 'world', cat: 'macro', url: 'https://www.ft.com/rss/home' },
  { id: 'bloomberg-politics', name: 'Bloomberg Politics', region: 'world', cat: 'macro', url: 'https://feeds.bloomberg.com/politics/news.rss' },
  { id: 'nyt-world', name: 'NYT World', region: 'world', cat: 'macro', url: NYT('World') },
  { id: 'dw', name: 'DW', region: 'world', cat: 'macro', url: 'https://rss.dw.com/rdf/rss-en-all' },
  { id: 'france24', name: 'France 24', region: 'world', cat: 'macro', url: 'https://www.france24.com/en/rss' },
  { id: 'euronews', name: 'Euronews', region: 'world', cat: 'macro', url: 'https://www.euronews.com/rss?format=mrss&level=theme&name=news' },
  { id: 'skynews', name: 'Sky News', region: 'world', cat: 'macro', url: 'https://feeds.skynews.com/feeds/rss/world.xml' },
  { id: 'politico-eu', name: 'Politico EU', region: 'world', cat: 'macro', url: 'https://www.politico.eu/feed/' },
  { id: 'defense', name: 'Defense News', region: 'world', cat: 'macro', url: 'https://www.defensenews.com/arc/outboundfeeds/rss/' },
  { id: 'cnbc-world', name: 'CNBC World', region: 'world', cat: 'macro', url: CNBC(100727362) },
  { id: 'oilprice', name: 'OilPrice', region: 'world', cat: 'macro', url: 'https://oilprice.com/rss/main' },
  { id: 'ecb', name: 'ECB', region: 'world', cat: 'macro', url: 'https://www.ecb.europa.eu/rss/press.html', official: true },
  { id: 'economist', name: 'The Economist', region: 'world', cat: 'markets', url: 'https://www.economist.com/finance-and-economics/rss.xml' },
  { id: 'bloomberg-markets', name: 'Bloomberg Markets', region: 'world', cat: 'markets', url: 'https://feeds.bloomberg.com/markets/news.rss' },
  { id: 'bbc-business', name: 'BBC Business', region: 'world', cat: 'markets', url: 'https://feeds.bbci.co.uk/news/business/rss.xml' },
  { id: 'guardian-biz', name: 'Guardian Business', region: 'world', cat: 'markets', url: 'https://www.theguardian.com/uk/business/rss' },
  { id: 'fxstreet', name: 'FXStreet', region: 'world', cat: 'markets', url: 'https://www.fxstreet.com/rss/news' },
  { id: 'investinglive', name: 'investingLive', region: 'world', cat: 'markets', url: 'https://investinglive.com/feed/news' },
  { id: 'coindesk', name: 'CoinDesk', region: 'world', cat: 'crypto', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { id: 'cointelegraph', name: 'Cointelegraph', region: 'world', cat: 'crypto', url: 'https://cointelegraph.com/rss' },
  { id: 'theblock', name: 'The Block', region: 'world', cat: 'crypto', url: 'https://www.theblock.co/rss.xml' },
  { id: 'decrypt', name: 'Decrypt', region: 'world', cat: 'crypto', url: 'https://decrypt.co/feed' },
  { id: 'btcmag', name: 'Bitcoin Magazine', region: 'world', cat: 'crypto', url: 'https://bitcoinmagazine.com/.rss/full/' },
  // ── USA ──
  { id: 'fed', name: 'Federal Reserve', region: 'us', cat: 'macro', url: 'https://www.federalreserve.gov/feeds/press_all.xml', official: true },
  { id: 'nyt-us', name: 'NYT U.S.', region: 'us', cat: 'macro', url: NYT('US') },
  { id: 'nyt-economy', name: 'NYT Economy', region: 'us', cat: 'macro', url: NYT('Economy') },
  { id: 'cnbc-economy', name: 'CNBC Economy', region: 'us', cat: 'macro', url: CNBC(20910258) },
  { id: 'npr', name: 'NPR', region: 'us', cat: 'macro', url: 'https://feeds.npr.org/1004/rss.xml' },
  { id: 'cbs', name: 'CBS News', region: 'us', cat: 'macro', url: 'https://www.cbsnews.com/latest/rss/main' },
  { id: 'thehill', name: 'The Hill', region: 'us', cat: 'macro', url: 'https://thehill.com/news/feed/' },
  { id: 'axios', name: 'Axios', region: 'us', cat: 'macro', url: 'https://api.axios.com/feed/' },
  { id: 'cnbc-top', name: 'CNBC', region: 'us', cat: 'markets', url: CNBC(100003114) },
  { id: 'cnbc-markets', name: 'CNBC Markets', region: 'us', cat: 'markets', url: CNBC(20409666) },
  { id: 'cnbc-earnings', name: 'CNBC Earnings', region: 'us', cat: 'markets', url: CNBC(15839135) },
  { id: 'nyt-business', name: 'NYT Business', region: 'us', cat: 'markets', url: NYT('Business') },
  { id: 'bloomberg-tech', name: 'Bloomberg Tech', region: 'us', cat: 'markets', url: 'https://feeds.bloomberg.com/technology/news.rss' },
  { id: 'marketwatch', name: 'MarketWatch', region: 'us', cat: 'markets', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
  { id: 'seekingalpha', name: 'Seeking Alpha', region: 'us', cat: 'markets', url: 'https://seekingalpha.com/market_currents.xml' },
  { id: 'foxbiz', name: 'Fox Business', region: 'us', cat: 'markets', url: 'https://moxie.foxbusiness.com/google-publisher/latest.xml' },
  { id: 'nasdaq-earn', name: 'Nasdaq Earnings', region: 'us', cat: 'markets', url: 'https://www.nasdaq.com/feed/rssoutbound?category=Earnings' },
  { id: 'zerohedge', name: 'ZeroHedge', region: 'us', cat: 'markets', url: 'https://feeds.feedburner.com/zerohedge/feed' },
  { id: 'sec', name: 'SEC', region: 'us', cat: 'crypto', url: 'https://www.sec.gov/news/pressreleases.rss', official: true, headers: { 'User-Agent': 'FinTerm/1.0 (self-hosted terminal; admin@localhost)' } },
  // ── Česko ──
  { id: 'ct24', name: 'ČT24', region: 'cz', cat: 'macro', url: 'https://ct24.ceskatelevize.cz/rss/hlavni-zpravy' },
  { id: 'ct24-svet', name: 'ČT24 Svět', region: 'cz', cat: 'macro', url: 'https://ct24.ceskatelevize.cz/rss/svet' },
  { id: 'irozhlas', name: 'iRozhlas', region: 'cz', cat: 'macro', url: 'https://www.irozhlas.cz/rss/irozhlas' },
  { id: 'seznamzpravy', name: 'Seznam Zprávy', region: 'cz', cat: 'macro', url: 'https://www.seznamzpravy.cz/rss' },
  { id: 'idnes', name: 'iDNES', region: 'cz', cat: 'macro', url: 'https://servis.idnes.cz/rss.aspx?c=zpravodaj' },
  { id: 'aktualne', name: 'Aktuálně.cz', region: 'cz', cat: 'macro', url: 'https://www.aktualne.cz/rss/' },
  { id: 'hn', name: 'Hospodářské noviny', region: 'cz', cat: 'macro', url: 'https://hn.cz/?m=rss' },
  { id: 'denikn', name: 'Deník N', region: 'cz', cat: 'macro', url: 'https://denikn.cz/feed/' },
  { id: 'lidovky', name: 'Lidovky', region: 'cz', cat: 'macro', url: 'https://servis.lidovky.cz/rss.aspx?c=ln_domov' },
  { id: 'ct24-eko', name: 'ČT24 Ekonomika', region: 'cz', cat: 'markets', url: 'https://ct24.ceskatelevize.cz/rss/ekonomika' },
  { id: 'hn-byznys', name: 'HN Byznys', region: 'cz', cat: 'markets', url: 'https://byznys.hn.cz/?m=rss' },
  { id: 'e15', name: 'E15', region: 'cz', cat: 'markets', url: 'https://www.e15.cz/rss' },
  { id: 'idnes-eko', name: 'iDNES Ekonomika', region: 'cz', cat: 'markets', url: 'https://servis.idnes.cz/rss.aspx?c=ekonomikah' },
  { id: 'aktualne-eko', name: 'Aktuálně Ekonomika', region: 'cz', cat: 'markets', url: 'https://www.aktualne.cz/rss/ekonomika/' },
  { id: 'novinky-eko', name: 'Novinky Ekonomika', region: 'cz', cat: 'markets', url: 'https://www.novinky.cz/rss/ekonomika' },
  { id: 'kurzy', name: 'Kurzy.cz', region: 'cz', cat: 'markets', url: 'https://www.kurzy.cz/zpravy/util/forext.dat?type=rss' },
  { id: 'penize', name: 'Peníze.cz', region: 'cz', cat: 'markets', url: 'https://www.penize.cz/rss' },
  { id: 'roklen', name: 'Roklen24', region: 'cz', cat: 'markets', url: 'https://www.roklen24.cz/rss/' },
  { id: 'forbescz', name: 'Forbes CZ', region: 'cz', cat: 'markets', url: 'https://forbes.cz/feed/' },
  { id: 'czechcrunch', name: 'CzechCrunch', region: 'cz', cat: 'markets', url: 'https://cc.cz/feed/' },
];

const TAG_RULES = [
  ['BREAKING', /\b(breaking|urgent|just in|flash)\b|naléhav|mimořádn/i, 3],
  ['FED', /\b(fed|fomc|powell|federal reserve|warsh)\b/i, 3],
  ['ECB', /\b(ecb|lagarde)\b/i, 2],
  ['ČNB', /čnb|\bcnb\b|národní banka|michl/i, 2],
  ['SAZBY', /\b(rate (cut|hike|decision)s?|interest rates?|yields?|treasur(y|ies)|bond market)\b|sazb/i, 2],
  ['INFLACE', /\b(inflation|cpi|pce|ppi|prices rose)\b|inflac|zdražo/i, 3],
  ['PRÁCE', /\b(payrolls?|nfp|jobless|unemployment|jobs report|labor market)\b|nezaměstn/i, 2],
  ['HDP', /\b(gdp|recession|economic growth)\b|\bhdp\b|recese/i, 2],
  ['VÁLKA', /\b(war|missiles?|airstrikes?|invasion|military|troops|drones?|ceasefire|nato|shelling)\b|válk|útok|armád|raket/i, 3],
  ['SANKCE', /\b(sanctions?|embargo|tariffs?|trade war|export controls?)\b|sankc|\bcla\b|clo\b/i, 3],
  ['VOLBY', /\b(elections?|referendum|vote|polls)\b|volb|voleb/i, 1],
  ['ENERGIE', /\b(oil|opec|brent|wti|crude|natural gas|lng|energy)\b|ropa|ropy|plyn|energ/i, 2],
  ['ČÍNA', /\b(china|chinese|beijing|xi jinping|yuan|pboc)\b|čín/i, 1],
  ['EARNINGS', /\b(earnings|revenue|guidance|eps|quarterly results|beats|misses|profit warning)\b|výsledk|zisk/i, 2],
  ['M&A', /\b(acquires?|acquisition|merger|takeover|buyout)\b|akvizic|fúz|převzetí/i, 1],
  ['AI', /\b(ai|artificial intelligence|openai|nvidia|chips?|semiconductors?)\b|umělá inteligence/i, 1],
  ['SEC', /\b(sec|cftc|atkins)\b/i, 2],
  ['ETF', /\betfs?\b/i, 2],
  ['BTC', /\b(bitcoin|btc)\b/i, 1],
  ['ETH', /\b(ethereum|ether|eth)\b/i, 1],
  ['REGULACE', /\b(regulat\w+|lawsuit|court|ruling|mica|stablecoin (bill|law)|genius act|clarity act|ban)\b|regulac|zákon|soud/i, 2],
  ['HACK', /\b(hack(ed|ers?)?|exploit|breach|stolen|drained)\b|hacker/i, 2],
  ['KRACH', /\b(crash|plunge|selloff|sell-off|rout|tumble|soar|surge|record high)s?\b|propad|krach|rekord/i, 2],
];

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', euro: '€', pound: '£', copy: '©', reg: '®', trade: '™' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const c = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(c) ? String.fromCodePoint(c) : m; }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
function cleanText(s) {
  if (!s) return '';
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  s = decodeEntities(s);
  s = s.replace(/<[^>]*>/g, ' ');
  s = decodeEntities(s);
  return s.replace(/\s+/g, ' ').trim();
}
function xmlTag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
}

const firstSeen = new Map();
function parseFeed(xml, feed) {
  const items = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/(item|entry)>/gi) || [];
  const now = Date.now();
  for (const b of blocks.slice(0, 40)) {
    const title = cleanText(xmlTag(b, 'title'));
    if (!title) continue;
    let link = cleanText(xmlTag(b, 'link'));
    if (!/^https?:/i.test(link)) { const m = b.match(/<link\b[^>]*href=["']([^"']+)["']/i); link = m ? decodeEntities(m[1]) : ''; }
    if (!/^https?:/i.test(link)) { const g = cleanText(xmlTag(b, 'guid')); if (/^https?:/i.test(g)) link = g; }
    const dateStr = cleanText(xmlTag(b, 'pubDate') || xmlTag(b, 'dc:date') || xmlTag(b, 'published') || xmlTag(b, 'updated'));
    const id = hash(link || title);
    let ts = Date.parse(dateStr);
    if (!Number.isFinite(ts)) { if (!firstSeen.has(id)) firstSeen.set(id, now); ts = firstSeen.get(id); }
    ts = Math.min(ts, now);
    const summary = cleanText(xmlTag(b, 'description') || xmlTag(b, 'summary') || xmlTag(b, 'content')).slice(0, 320);
    const text = title + ' ' + summary.slice(0, 160);
    const tags = [];
    let score = feed.official ? 2 : 0;
    for (const [tag, re, w] of TAG_RULES) if (re.test(text)) { tags.push(tag); score += w; }
    if (re2.test(title)) score += 1;
    items.push({ id, key: title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 90), title, link, summary, ts, source: feed.name, feed: feed.id, cat: feed.cat, region: feed.region, tags: tags.slice(0, 5), score });
  }
  return items;
}
const re2 = /^[^a-z]*[A-Z]{3,}[^a-z]*:/; // "BREAKING:" / "FED:" style prefixes

const feedStatus = {};
function allFeeds() {
  const s = state.settings?.news || {};
  const disabled = new Set(s.disabled || []);
  const custom = (Array.isArray(s.custom) ? s.custom : []).filter(f => f && /^https?:\/\//.test(f.url || '')).map(f => ({
    id: f.id || 'custom-' + hash(f.url), name: String(f.name || '').slice(0, 40) || new URL(f.url).hostname,
    cat: ['macro', 'markets', 'crypto'].includes(f.cat) ? f.cat : 'markets',
    region: ['cz', 'us', 'world'].includes(f.region) ? f.region : 'world', url: f.url, custom: true,
  }));
  return [...FEEDS, ...custom].map(f => ({ ...f, enabled: !disabled.has(f.id) }));
}

function loadFeed(f) {
  return cached('feed:' + f.id + ':' + hash(f.url), 4 * 60e3, async () => {
    try {
      const xml = f.custom ? await fetchPublicText(f.url, { timeout: 15000 }) : await fetchText(f.url, { timeout: 15000, headers: { Accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml,*/*', ...(f.headers || {}) } });
      const items = parseFeed(xml, f);
      feedStatus[f.id] = { ok: true, t: Date.now(), count: items.length, newest: items.reduce((m, i) => Math.max(m, i.ts), 0) };
      return items;
    } catch (e) {
      feedStatus[f.id] = { ...(feedStatus[f.id] || {}), ok: false, t: Date.now(), err: e.message };
      throw e;
    }
  }).catch(() => []);
}

let newsItems = [], newsUpdated = 0, newsPending = null, newsPrimed = false;
const seenNews = new Set();
const BREAKING_MIN = 6;
async function refreshNews() {
  const feeds = allFeeds().filter(f => f.enabled);
  const lists = await mapLimit(feeds, 8, loadFeed);
  const byKey = new Map();
  for (const it of lists.flat()) {
    if (!it) continue;
    const ex = byKey.get(it.key);
    if (!ex) byKey.set(it.key, { ...it });
    else if (!ex.also?.includes(it.source) && ex.source !== it.source) ex.also = [...(ex.also || []), it.source].slice(0, 4);
  }
  const now = Date.now();
  const arr = [...byKey.values()].filter(i => now - i.ts < 7 * 864e5).sort((a, b) => b.ts - a.ts).slice(0, 1500);
  for (const i of arr) if (i.also) i.score += Math.min(2, i.also.length); // multi-source confirmation
  if (newsPrimed) {
    const fresh = arr.filter(i => !seenNews.has(i.id) && i.score >= BREAKING_MIN && now - i.ts < 45 * 60e3);
    for (const i of fresh.slice(0, 5)) onBreaking(i);
  }
  for (const i of arr) seenNews.add(i.id);
  if (seenNews.size > 8000) { seenNews.clear(); arr.forEach(i => seenNews.add(i.id)); }
  if (firstSeen.size > 8000) firstSeen.clear();
  newsPrimed = true;
  newsItems = arr;
  newsUpdated = now;
  mark('news', arr.length > 0, arr.length ? '' : 'no items');
  return arr;
}
function getNews() {
  if (newsItems.length && Date.now() - newsUpdated < 3 * 60e3) return Promise.resolve(newsItems);
  if (!newsPending) newsPending = refreshNews().finally(() => { newsPending = null; });
  return newsItems.length ? Promise.resolve(newsItems) : newsPending;
}

let breakingPushes = [];
function onBreaking(item) {
  pushEvent({ type: 'news', title: `${item.source}: ${item.title}`, message: item.summary.slice(0, 160), link: item.link, tags: item.tags, score: item.score });
  const n = state.settings?.notify || {};
  if (!n.breaking) return;
  if (item.score < (+n.breakingMin || BREAKING_MIN)) return;
  const now = Date.now();
  breakingPushes = breakingPushes.filter(t => now - t < 3600e3);
  if (breakingPushes.length >= (+n.breakingPerHour || 6)) return;
  breakingPushes.push(now);
  notifyAll(`📰 ${item.source}`, item.title, { tags: 'newspaper', click: item.link }).catch(() => {});
}

// ───────────────────────────── Events & notifications ─────────────────────────────
const events = [];
let eventSeq = 0;
function pushEvent(e) {
  events.push({ id: ++eventSeq, ts: Date.now(), ...e });
  if (events.length > 300) events.splice(0, events.length - 300);
}

const encodeHeader = s => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
async function notifyAll(title, message, opts = {}) {
  const n = state.settings?.notify || {};
  const jobs = [];
  if (n.ntfyUrl && /^https?:\/\//.test(n.ntfyUrl)) {
    jobs.push(['ntfy', fetchRaw(n.ntfyUrl, {
      method: 'POST', body: message, timeout: 10000,
      headers: { Title: encodeHeader(title), Priority: opts.priority === 'high' ? '4' : '3', Tags: opts.tags || 'chart_with_upwards_trend', ...(opts.click ? { Click: opts.click } : {}), ...(n.ntfyToken ? { Authorization: 'Bearer ' + n.ntfyToken } : {}) },
    })]);
  }
  if (n.telegramToken && n.telegramChat) {
    jobs.push(['telegram', fetchRaw(`https://api.telegram.org/bot${encodeURIComponent(n.telegramToken)}/sendMessage`, {
      method: 'POST', timeout: 10000, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: n.telegramChat, text: `${title}\n${message}${opts.click ? '\n' + opts.click : ''}`, disable_web_page_preview: true }),
    })]);
  }
  if (n.webhookUrl && /^https?:\/\//.test(n.webhookUrl)) {
    jobs.push(['webhook', fetchRaw(n.webhookUrl, { method: 'POST', timeout: 10000, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'finterm', title, message, ts: Date.now(), ...(opts.data || {}) }) })]);
  }
  const res = await Promise.allSettled(jobs.map(j => j[1]));
  return jobs.map((j, i) => ({ channel: j[0], ok: res[i].status === 'fulfilled' && res[i].value.ok, status: res[i].value?.status, error: res[i].reason?.message }));
}

// ───────────────────────────── Alerts engine ─────────────────────────────
const fmtNum = v => (Math.abs(v) >= 1000 ? v.toFixed(2) : Math.abs(v) >= 1 ? v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') : v.toPrecision(4));
let alertsRunning = false;
async function runAlerts() {
  if (alertsRunning) return;
  const items = (state.alerts?.items || []).filter(a => a && a.active && a.symbol);
  if (!items.length) return;
  alertsRunning = true;
  try {
    const quotes = await getQuotes([...new Set(items.map(a => String(a.symbol).toUpperCase()))]);
    let changed = false;
    for (const a of items) {
      const q = quotes[String(a.symbol).toUpperCase()];
      if (!q || q.price == null || q.stale) continue;
      const v = +a.value;
      let hit = false, desc = '';
      if (a.cond === 'above') { hit = q.price >= v; desc = `cena ≥ ${v}`; }
      else if (a.cond === 'below') { hit = q.price <= v; desc = `cena ≤ ${v}`; }
      else if (a.cond === 'pct_up') { hit = q.changePct >= Math.abs(v); desc = `denní změna ≥ +${Math.abs(v)} %`; }
      else if (a.cond === 'pct_down') { hit = q.changePct <= -Math.abs(v); desc = `denní změna ≤ −${Math.abs(v)} %`; }
      a.lastPrice = q.price;
      a.lastCheck = Date.now();
      if (!hit) continue;
      if (a.repeat && a.triggeredAt && Date.now() - a.triggeredAt < (+a.cooldownMin || 60) * 60e3) continue;
      a.triggeredAt = Date.now();
      a.count = (a.count || 0) + 1;
      if (!a.repeat) a.active = false;
      changed = true;
      const msg = `${a.symbol} = ${fmtNum(q.price)} ${q.currency || ''} (${q.changePct >= 0 ? '+' : ''}${(q.changePct || 0).toFixed(2)} %) – ${desc}${a.note ? ' · ' + a.note : ''}`;
      pushEvent({ type: 'alert', title: `🔔 Alert ${a.symbol}`, message: msg, alertId: a.id, symbol: a.symbol, price: q.price });
      state.alerts.history = [{ id: hash(a.id + a.triggeredAt), alertId: a.id, symbol: a.symbol, ts: a.triggeredAt, price: q.price, message: msg }, ...(state.alerts.history || [])].slice(0, 200);
      notifyAll(`🔔 FinTerm alert: ${a.symbol}`, msg, { priority: 'high', tags: 'bell', data: { symbol: a.symbol, price: q.price } }).catch(() => {});
    }
    if (changed) saveState();
  } finally {
    alertsRunning = false;
  }
}

// ───────────────────────────── Portfolio (Ghostfolio-style analysis) ─────────────────────────────
const EXT_FILE = path.join(DATA_DIR, 'portfolio-external.json');
let ext = { activities: [], accounts: [], source: null, syncedAt: null };
function loadExt() { try { ext = JSON.parse(fs.readFileSync(EXT_FILE, 'utf8')) || ext; } catch { /* first run */ } }
function saveExt() { writeJSONAtomic(EXT_FILE, ext); cache.forEach((v, k) => { if (k.startsWith('pfa:')) cache.delete(k); }); }

const _ldf = {};
function localDate(ts, tz) {
  tz = tz || (state.settings && state.settings.timezone) || 'Europe/Prague';
  let f = _ldf[tz];
  if (!f) { try { f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }); } catch { f = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }); } _ldf[tz] = f; }
  return f.format(ts);
}

const CG_MAP = { bitcoin: 'BTC-USD', ethereum: 'ETH-USD', solana: 'SOL-USD', ripple: 'XRP-USD', cardano: 'ADA-USD', dogecoin: 'DOGE-USD', binancecoin: 'BNB-USD', tron: 'TRX-USD', chainlink: 'LINK-USD', 'avalanche-2': 'AVAX-USD', polkadot: 'DOT-USD', litecoin: 'LTC-USD', 'bitcoin-cash': 'BCH-USD', monero: 'XMR-USD', stellar: 'XLM-USD', 'shiba-inu': 'SHIB-USD', cosmos: 'ATOM-USD', 'matic-network': 'POL-USD', uniswap: 'UNI-USD', 'ethereum-classic': 'ETC-USD' };
async function cgToYahoo(id) {
  if (CG_MAP[id]) return CG_MAP[id];
  try { const m = (await getCryptoMarkets()).find(c => c.id === id); if (m) return m.symbol.toUpperCase() + '-USD'; } catch { /* offline */ }
  return null;
}

async function convertGhostfolio(j) {
  if (!j || !Array.isArray(j.activities)) throw Object.assign(new Error('Soubor není Ghostfolio export (chybí activities)'), { status: 400 });
  const accounts = (j.accounts || []).map(a => {
    const bal = Array.isArray(a.balances) && a.balances.length ? [...a.balances].sort((x, y) => String(x.date).localeCompare(String(y.date))).pop().value : a.balance;
    return { id: a.id, name: a.name || 'Účet', currency: a.currency || 'USD', balance: +bal || 0, excluded: !!a.isExcluded };
  });
  const accName = Object.fromEntries(accounts.map(a => [a.id, a.name]));
  const out = [], unknown = [];
  for (const a of j.activities) {
    const type = String(a.type || '').toUpperCase();
    const ds = String(a.dataSource || (a.SymbolProfile && a.SymbolProfile.dataSource) || 'YAHOO').toUpperCase();
    const sym = a.symbol || (a.SymbolProfile && a.SymbolProfile.symbol) || '';
    let y = ds === 'COINGECKO' ? await cgToYahoo(sym) : ds === 'MANUAL' ? 'MANUAL:' + sym : String(sym).toUpperCase();
    if (!y) { unknown.push(`${ds}:${sym}`); y = 'MANUAL:' + sym; }
    const ts = Date.parse(a.date);
    out.push({
      id: 'gf-' + hash(JSON.stringify([a.id || '', a.date, sym, type, a.quantity, a.unitPrice, a.accountId])), date: Number.isFinite(ts) ? localDate(ts) : String(a.date).slice(0, 10),
      type, symbol: y, origSymbol: sym, dataSource: ds, qty: +a.quantity || 0, price: +a.unitPrice || 0, fee: +a.fee || 0,
      currency: a.currency || (a.SymbolProfile && a.SymbolProfile.currency) || 'USD', account: accName[a.accountId] || '', comment: a.comment || '', source: 'ghostfolio',
    });
  }
  return { activities: out, accounts, unknown, baseCurrency: (j.user && j.user.settings && j.user.settings.currency) || null, meta: j.meta || null };
}

// Ghostfolio REST API (self-hosted): POST /api/v1/auth/anonymous {accessToken} → JWT, GET /api/v1/export → activities
const gf = { jwt: null, t: 0, key: '', base: null };
function gfCandidates() {
  const g = (state.settings && state.settings.ghostfolio) || {};
  const u = String(g.url || '').trim().replace(/\/+$/, '').replace(/\/(?:[a-z]{2})(?:\/.*)?$/i, '');
  // Umbrel puts Ghostfolio behind its login proxy (302 → app-auth), so the internal container address is tried as well
  return [...new Set([u, process.env.GHOSTFOLIO_URL, 'http://ghostfolio_server_1:3334'].filter(x => x && /^https?:\/\//.test(x)))];
}
async function gfJSON(base, p, opts = {}) {
  const r = await fetchRaw(base + p, { ...opts, timeout: opts.timeout || 20000, redirect: 'manual', headers: { Accept: 'application/json', ...(opts.headers || {}) } });
  const ct = r.headers.get('content-type') || '';
  if (r.status >= 300 && r.status < 400) throw Object.assign(new Error('přesměrování na přihlášení (Umbrel proxy)'), { soft: true });
  if (!/json/.test(ct)) throw Object.assign(new Error(`odpověď není JSON (HTTP ${r.status})`), { soft: true, status: r.status });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error((j && (j.message || j.error)) || 'HTTP ' + r.status), { status: r.status });
  return j;
}
async function gfLogin(base, token) {
  try { return (await gfJSON(base, '/api/v1/auth/anonymous', { method: 'POST', body: JSON.stringify({ accessToken: token }), headers: { 'Content-Type': 'application/json' } })).authToken; }
  catch (e) { if (e.status !== 404 && e.status !== 405) throw e; }
  return (await gfJSON(base, '/api/v1/auth/anonymous/' + encodeURIComponent(token))).authToken; // older Ghostfolio versions
}
async function ghostfolioSync() {
  const token = ((state.settings && state.settings.ghostfolio) || {}).token;
  const list = gfCandidates();
  if (!token || !list.length) throw Object.assign(new Error('Ghostfolio není nastaven – vyplňte URL a Security Token v Nastavení → Ghostfolio'), { status: 400 });
  const errors = [];
  for (const base of gf.base && list.includes(gf.base) ? [gf.base, ...list.filter(b => b !== gf.base)] : list) {
    try {
      let jwt = gf.jwt && gf.key === base + token && Date.now() - gf.t < 6 * 3600e3 ? gf.jwt : null;
      if (!jwt) { jwt = await gfLogin(base, token); if (!jwt) throw new Error('přihlášení tokenem selhalo'); gf.jwt = jwt; gf.t = Date.now(); gf.key = base + token; }
      let exp;
      try { exp = await gfJSON(base, '/api/v1/export', { headers: { Authorization: 'Bearer ' + jwt }, timeout: 40000 }); }
      catch (e) { if (e.status !== 401 && e.status !== 403) throw e; jwt = await gfLogin(base, token); gf.jwt = jwt; gf.t = Date.now(); exp = await gfJSON(base, '/api/v1/export', { headers: { Authorization: 'Bearer ' + jwt }, timeout: 40000 }); }
      const conv = await convertGhostfolio(exp);
      let perf = null;
      try { const pj = await gfJSON(base, '/api/v2/portfolio/performance?range=max', { headers: { Authorization: 'Bearer ' + jwt } }); perf = pj.performance || null; } catch { /* optional */ }
      gf.base = base;
      ext = { ...conv, source: 'ghostfolio-api', url: base, syncedAt: Date.now(), gfPerformance: perf, error: null };
      saveExt();
      mark('ghostfolio', true);
      return { ok: true, url: base, activities: conv.activities.length, accounts: conv.accounts.length, unknown: conv.unknown };
    } catch (e) { errors.push(`${base}: ${e.message}`); }
  }
  ext.error = errors.join(' | ');
  mark('ghostfolio', false, ext.error);
  throw Object.assign(new Error('Synchronizace s Ghostfoliem selhala – ' + ext.error), { status: 502 });
}

const SECTOR_CS = { Technology: 'Technologie', 'Financial Services': 'Finance', Healthcare: 'Zdravotnictví', 'Consumer Cyclical': 'Zbytná spotřeba', 'Consumer Defensive': 'Základní spotřeba', Industrials: 'Průmysl', Energy: 'Energie', Utilities: 'Utility', 'Real Estate': 'Nemovitosti', 'Basic Materials': 'Materiály', 'Communication Services': 'Komunikace' };
const ETF_SECTOR = { technology: 'Technologie', financial_services: 'Finance', healthcare: 'Zdravotnictví', consumer_cyclical: 'Zbytná spotřeba', consumer_defensive: 'Základní spotřeba', industrials: 'Průmysl', energy: 'Energie', utilities: 'Utility', realestate: 'Nemovitosti', basic_materials: 'Materiály', communication_services: 'Komunikace' };
const COUNTRY_CS = { 'United States': 'USA', Netherlands: 'Nizozemsko', France: 'Francie', Germany: 'Německo', 'Czech Republic': 'Česko', Czechia: 'Česko', 'United Kingdom': 'Velká Británie', Ireland: 'Irsko', Switzerland: 'Švýcarsko', Taiwan: 'Tchaj-wan', China: 'Čína', Japan: 'Japonsko', Canada: 'Kanada', Denmark: 'Dánsko', Sweden: 'Švédsko', Spain: 'Španělsko', Italy: 'Itálie', Austria: 'Rakousko', Poland: 'Polsko', 'South Korea': 'Jižní Korea', India: 'Indie', Israel: 'Izrael', Brazil: 'Brazílie', Australia: 'Austrálie', Belgium: 'Belgie', Norway: 'Norsko', Finland: 'Finsko', Luxembourg: 'Lucembursko', 'Hong Kong': 'Hongkong', Singapore: 'Singapur' };
function getProfile(sym) {
  return cached('prof:' + sym, 24 * 3600e3, async () => {
    const j = await yahooJSON(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=assetProfile,quoteType,topHoldings,fundProfile`);
    const r = (j && j.quoteSummary && j.quoteSummary.result && j.quoteSummary.result[0]) || {};
    const ap = r.assetProfile || {}, th = r.topHoldings || {}, sw = {};
    for (const o of th.sectorWeightings || []) for (const [k, v] of Object.entries(o)) { const w = yraw(v); if (w > 0) { const n = ETF_SECTOR[k] || k; sw[n] = (sw[n] || 0) + w; } }
    return { sector: ap.sector || null, country: ap.country || null, sectorWeights: Object.keys(sw).length ? sw : null, category: (r.fundProfile && r.fundProfile.categoryName) || null };
  }).catch(() => ({}));
}
function etfRegion(name) {
  const n = String(name || '');
  if (/s&p 500|nasdaq|russell|dow jones|\bus\b|usa|united states/i.test(n)) return 'USA';
  if (/world|all-world|global|acwi|ftse all/i.test(n)) return 'Globální';
  if (/europe|stoxx|euro/i.test(n)) return 'Evropa';
  if (/emerging/i.test(n)) return 'Rozvíjející se trhy';
  return 'Fondy (ostatní)';
}

const ACT_TYPES = new Set(['BUY', 'SELL', 'DIVIDEND', 'INTEREST', 'FEE', 'ITEM', 'LIABILITY']);
function allActivities() {
  const manual = (state.portfolio && Array.isArray(state.portfolio.activities) ? state.portfolio.activities : []).map(a => ({ ...a, source: a.source || 'manual' }));
  return [...(Array.isArray(ext.activities) ? ext.activities : []), ...manual]
    .filter(a => a && a.symbol && /^\d{4}-\d{2}-\d{2}$/.test(a.date || '') && ACT_TYPES.has(a.type))
    .map(a => ({ ...a, qty: Math.abs(+a.qty || 0), price: +a.price || 0, fee: +a.fee || 0, currency: a.currency || 'USD' }))
    .sort((x, y) => x.date.localeCompare(y.date) || (x.type === 'SELL') - (y.type === 'SELL'));
}

const CLASS_OF = { EQUITY: 'Akcie', ETF: 'ETF', CRYPTOCURRENCY: 'Krypto', MUTUALFUND: 'Fondy', FUTURE: 'Komodity', CURRENCY: 'Měny', INDEX: 'Index' };
const unitNorm = c => (c === 'GBp' || c === 'GBX' ? ['GBP', 0.01] : c === 'ZAc' ? ['ZAR', 0.01] : c === 'ILA' ? ['ILS', 0.01] : c === 'USX' ? ['USD', 0.01] : [c, 1]);
function rangeFor(days) { return days <= 360 ? '1y' : days <= 720 ? '2y' : days <= 1800 ? '5y' : days <= 3600 ? '10y' : 'max'; }
function xirr(flows) {
  if (flows.length < 2 || !flows.some(f => f.v > 0) || !flows.some(f => f.v < 0)) return null;
  const t0 = flows[0].t, f = r => flows.reduce((s, x) => s + x.v / Math.pow(1 + r, (x.t - t0) / (365 * 864e5)), 0);
  let lo = -0.99, hi = 10, flo = f(lo), fhi = f(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < 100; i++) { const m = (lo + hi) / 2, fm = f(m); if (flo * fm <= 0) { hi = m; } else { lo = m; flo = fm; } }
  return (lo + hi) / 2;
}

async function portfolioAnalysis(base, bench) {
  const acts = allActivities();
  const key = `pfa:${base}:${bench}:${hash(JSON.stringify(acts.map(a => [a.id, a.date, a.type, a.symbol, a.qty, a.price])))}:${Math.floor(Date.now() / 60e3)}`;
  return cached(key, 60e3, async () => {
    const cashAcc = (ext.accounts || []).filter(a => a.balance > 0 && !a.excluded);
    if (!acts.length && !cashAcc.length) return { empty: true, base };
    const today = localDate(Date.now());
    const first = acts.length ? acts[0].date : today;
    const days = [];
    for (let t = Date.parse(first + 'T12:00:00Z'); ; t += 864e5) { const d = isoDate(t); days.push(d); if (d >= today) break; if (days.length > 6000) break; }
    const range = rangeFor(days.length);
    const syms = [...new Set(acts.filter(a => ['BUY', 'SELL', 'ITEM', 'LIABILITY'].includes(a.type)).map(a => a.symbol))];
    const market = syms.filter(s => !/^(CASH|MANUAL):/.test(s));
    const [quotes, charts, profiles] = await Promise.all([
      getQuotes(market).catch(() => ({})),
      mapLimit(market, 4, s => getChart(s, range, '1d')),
      mapLimit(market, 3, s => getProfile(s)),
    ]);
    const ch = {}, prof = {};
    market.forEach((s, i) => { ch[s] = charts[i]; prof[s] = profiles[i] || {}; });
    // currency of each holding (quote currency wins), constant for manual/cash
    const lastActPrice = {}, actCur = {};
    for (const a of acts) if (['BUY', 'SELL', 'ITEM', 'LIABILITY'].includes(a.type)) { lastActPrice[a.symbol] = a.price; actCur[a.symbol] = a.currency; }
    const curOf = s => (s.startsWith('CASH:') ? s.slice(5) : (quotes[s] && quotes[s].currency) || (ch[s] && ch[s].currency) || actCur[s] || 'USD');
    // FX series (to base) for every currency in play
    const curs = new Set([...syms.map(curOf), ...acts.map(a => a.currency), ...cashAcc.map(a => a.currency)]);
    const fxArr = {};
    await Promise.all([...curs].map(async c => {
      const [cn, cm] = unitNorm(c), [bn, bm] = unitNorm(base), mult = cm / bm;
      if (cn === bn) { fxArr[c] = days.map(() => mult); return; }
      let series = null;
      for (const [s, inv] of [[`${cn}${bn}=X`, false], ...(cn === 'USD' ? [[`${bn}=X`, false]] : []), [`${bn}${cn}=X`, true]]) {
        try { const x = await getChart(s, range, '1d'); if (x && x.c.length > 5) { series = { x, inv }; break; } } catch { /* try next */ }
      }
      const now = await fxFactor(c, base).catch(() => null);
      if (!series) { fxArr[c] = days.map(() => now || mult); return; }
      const m = new Map(); series.x.t.forEach((ts, i) => m.set(localDate(ts, series.x.tz || 'UTC'), series.inv ? 1 / series.x.c[i] : series.x.c[i]));
      let last = null; const firstVal = series.x.c.length ? (series.inv ? 1 / series.x.c[0] : series.x.c[0]) : now;
      fxArr[c] = days.map((d, i) => { if (m.has(d)) last = m.get(d) * mult; if (i === days.length - 1 && now) return now; return last ?? firstVal * mult; });
    }));
    const fxAt = (c, i) => (fxArr[c] ? fxArr[c][i] : 1);
    // price series aligned to calendar days (carry forward)
    const pxArr = {};
    for (const s of syms) {
      const x = ch[s];
      if (!x || !x.c.length) { const lp = lastActPrice[s] || 0; pxArr[s] = days.map(() => lp); continue; }
      const m = new Map(); x.t.forEach((ts, i) => m.set(localDate(ts, x.tz || 'UTC'), x.c[i]));
      let last = null;
      pxArr[s] = days.map(d => { if (m.has(d)) last = m.get(d); return last ?? x.c[0]; });
      const q = quotes[s];
      if (q && isFinite(q.price)) pxArr[s][days.length - 1] = q.price;
    }
    if (syms.some(s => s.startsWith('CASH:'))) syms.filter(s => s.startsWith('CASH:')).forEach(s => { pxArr[s] = days.map(() => 1); });
    // data-quality: trades priced far away from that day's market close
    const warnings = [];
    for (const a of acts) {
      if ((a.type !== 'BUY' && a.type !== 'SELL') || !ch[a.symbol] || unitNorm(a.currency)[0] !== unitNorm(curOf(a.symbol))[0]) continue;
      const i = days.indexOf(a.date), mk = i >= 0 ? pxArr[a.symbol][i] * unitNorm(curOf(a.symbol))[1] / unitNorm(a.currency)[1] : null;
      if (mk > 0 && a.price > 0 && Math.abs(a.price / mk - 1) > 0.25) warnings.push({ date: a.date, symbol: a.symbol, type: a.type, qty: a.qty, price: a.price, market: mk, dev: (a.price / mk - 1) * 100, currency: a.currency, source: a.source });
    }
    // benchmark
    let bx = null; try { bx = await getChart(bench, range, '1d'); } catch { /* none */ }
    let bArr = null;
    if (bx && bx.c.length) {
      const m = new Map(); bx.t.forEach((ts, i) => m.set(localDate(ts, bx.tz || 'UTC'), bx.c[i]));
      const bc = bx.currency || 'USD';
      if (!fxArr[bc]) { const k = await fxFactor(bc, base).catch(() => 1); fxArr[bc] = days.map(() => k); }
      let last = null; bArr = days.map((d, i) => { if (m.has(d)) last = m.get(d); return (last ?? bx.c[0]) * fxAt(bc, i); });
    }
    // day-by-day replay
    const byDay = {};
    for (const a of acts) (byDay[a.date] = byDay[a.date] || []).push(a);
    const H = {};
    const h = s => H[s] || (H[s] = { qty: 0, costB: 0, costL: 0, boughtB: 0, realized: 0, div: 0, fees: 0, first: null, flows: [], accounts: new Set() });
    let invested = 0, realized = 0, dividends = 0, fees = 0, feeOther = 0, idx = 1, prevV = 0, bUnits = 0, bIdx0 = null;
    const flows = [], out = { t: [], value: [], invested: [], index: [], bench: [], benchValue: [] }, rets = [], bRets = [];
    let prevB = null;
    for (let i = 0; i < days.length; i++) {
      const d = days[i], ts = Date.parse(d + 'T12:00:00Z');
      let cf = 0;
      for (const a of byDay[d] || []) {
        const fx = fxAt(a.currency, i), amtB = a.qty * a.price * fx, feeB = a.fee * fx, x = h(a.symbol);
        if (a.account) x.accounts.add(a.account);
        if (a.type === 'BUY' || a.type === 'ITEM') {
          x.qty += a.qty; x.costB += amtB + feeB; x.costL += a.qty * a.price + a.fee; x.boughtB += amtB + feeB; x.fees += feeB; x.first = x.first || d;
          invested += amtB + feeB; fees += feeB; cf += amtB + feeB;
          x.flows.push({ t: ts, v: -(amtB + feeB) }); flows.push({ t: ts, v: -(amtB + feeB) });
        } else if (a.type === 'SELL' && x.qty > 0) {
          const q = Math.min(a.qty, x.qty), part = q / x.qty, costSold = x.costB * part, proceeds = q * a.price * fx - feeB;
          x.realized += proceeds - costSold; realized += proceeds - costSold; x.costB -= costSold; x.costL -= x.costL * part; x.qty -= q; x.fees += feeB;
          invested -= costSold; fees += feeB; cf -= proceeds;
          x.flows.push({ t: ts, v: proceeds }); flows.push({ t: ts, v: proceeds });
        } else if (a.type === 'DIVIDEND' || a.type === 'INTEREST') {
          const amt = a.qty * a.price * fx - feeB; x.div += amt; dividends += amt; cf -= amt;
          x.flows.push({ t: ts, v: amt }); flows.push({ t: ts, v: amt });
        } else if (a.type === 'FEE') { const amt = (a.qty * a.price + a.fee) * fx; fees += amt; feeOther += amt; cf += amt; flows.push({ t: ts, v: -amt }); }
        else if (a.type === 'LIABILITY') { x.qty -= a.qty; x.costB -= amtB; invested -= amtB; cf -= amtB; }
      }
      let v = 0;
      for (const s of syms) { const x = H[s]; if (x && x.qty) v += x.qty * pxArr[s][i] * fxAt(curOf(s), i); }
      if (prevV > 0) {
        const r = (v - cf) / prevV - 1;
        if (Number.isFinite(r) && r > -0.95 && r < 5) {
          idx *= 1 + r;
          // risk stats only from days without cash flows (purchase-price quirks would distort them)
          if (!cf) { rets.push(r); if (bArr && prevB) bRets.push(bArr[i] / prevB - 1); else bRets.push(0); }
        }
      } else if (v > 0) idx = 1;
      if (bArr) {
        if (cf) bUnits += cf / bArr[i];
        if (bIdx0 === null && v > 0) bIdx0 = bArr[i];
        prevB = bArr[i];
      }
      prevV = v;
      out.t.push(ts); out.value.push(v); out.invested.push(invested); out.index.push(idx);
      out.bench.push(bArr && bIdx0 ? bArr[i] / bIdx0 : null); out.benchValue.push(bArr ? bUnits * bArr[i] : null);
    }
    // current holdings
    const li = days.length - 1, holdings = [], closed = [];
    let total = 0, dayChg = 0, projDiv = 0;
    for (const s of syms) {
      const x = H[s];
      if (!x) continue;
      const cur = curOf(s), fxNow = fxAt(cur, li), q = quotes[s] || {}, p = prof[s] || {};
      const price = pxArr[s][li], value = x.qty * price * fxNow;
      if (Math.abs(x.qty) < 1e-9) { if (x.realized || x.div) closed.push({ symbol: s, name: q.name || s, realized: x.realized, dividends: x.div }); continue; }
      const type = s.startsWith('CASH:') ? 'CASH' : q.type || (ch[s] && ch[s].meta && ch[s].meta.type) || (s.startsWith('MANUAL:') ? 'MANUAL' : null);
      const cls = type === 'CASH' ? 'Hotovost' : type === 'MANUAL' ? 'Ostatní' : CLASS_OF[type] || 'Ostatní';
      const sector = cls === 'Krypto' ? 'Krypto' : cls === 'Hotovost' ? 'Hotovost' : cls === 'ETF' || cls === 'Fondy' ? (p.sectorWeights ? null : 'ETF / fondy') : SECTOR_CS[p.sector] || p.sector || 'Neznámý';
      const country = cls === 'Krypto' ? 'Krypto' : cls === 'Hotovost' ? 'Hotovost' : cls === 'ETF' || cls === 'Fondy' ? etfRegion(q.name || q.longName) : COUNTRY_CS[p.country] || p.country || 'Neznámá';
      const dayB = q && isFinite(q.change) ? x.qty * q.change * fxNow : 0;
      const dy = isFinite(q.divYield) ? q.divYield : null;
      const pdiv = dy ? value * dy / 100 : 0;
      const years = (Date.now() - Date.parse(x.first + 'T12:00:00Z')) / (365 * 864e5);
      const irr = years >= 0.25 ? xirr([...x.flows, { t: Date.now(), v: value }]) : null;
      holdings.push({
        symbol: s, name: s.startsWith('CASH:') ? 'Hotovost ' + cur : q.longName || q.name || (s.startsWith('MANUAL:') ? s.slice(7) : s), type, cls, sector, sectorWeights: sector === null ? p.sectorWeights : null, country, currency: cur,
        accounts: [...x.accounts], qty: x.qty, avg: x.qty ? x.costL / x.qty : null, actCurrency: actCur[s], price, value, cost: x.costB, pl: value - x.costB, plPct: x.costB > 0 ? (value - x.costB) / x.costB * 100 : null,
        dayChange: dayB, dayPct: q.changePct ?? null, realized: x.realized, dividends: x.div, fees: x.fees, first: x.first, irr, divYield: dy, projDiv: pdiv, noQuote: !s.startsWith('CASH:') && !s.startsWith('MANUAL:') && !quotes[s],
      });
      total += value; dayChg += dayB; projDiv += pdiv;
    }
    let cashTotal = 0;
    for (const a of cashAcc) {
      const k = await fxFactor(a.currency, base).catch(() => 1), value = a.balance * k;
      holdings.push({ symbol: 'CASH:' + a.currency, name: `Hotovost – ${a.name}`, type: 'CASH', cls: 'Hotovost', sector: 'Hotovost', country: 'Hotovost', currency: a.currency, accounts: [a.name], qty: a.balance, avg: 1, price: 1, value, cost: value, pl: 0, plPct: 0, dayChange: 0, dividends: 0, realized: 0, first: null, cash: true });
      cashTotal += value; total += value;
    }
    for (const x of holdings) x.weight = total ? x.value / total * 100 : 0;
    holdings.sort((a, b) => b.value - a.value);
    // allocations
    const agg = fn => { const m = {}; for (const x of holdings) for (const [k, v] of fn(x)) m[k] = (m[k] || 0) + v; return Object.entries(m).map(([label, value]) => ({ label, value, pct: total ? value / total * 100 : 0 })).sort((a, b) => b.value - a.value); };
    const alloc = {
      holding: holdings.map(x => ({ label: x.symbol.replace(/^CASH:/, 'Hotovost ').replace(/^MANUAL:/, ''), value: x.value, pct: x.weight })),
      cls: agg(x => [[x.cls, x.value]]),
      sector: agg(x => (x.sectorWeights ? Object.entries(x.sectorWeights).map(([k, w]) => [k, x.value * w / Object.values(x.sectorWeights).reduce((s, y) => s + y, 0)]) : [[x.sector || 'ETF / fondy', x.value]])),
      country: agg(x => [[x.country, x.value]]),
      currency: agg(x => [[unitNorm(x.currency)[0], x.value]]),
      account: agg(x => [[(x.accounts && x.accounts[0]) || 'Bez účtu', x.value]]),
    };
    // summary & risk
    const openCost = holdings.filter(x => !x.cash).reduce((s, x) => s + x.cost, 0);
    const unreal = total - cashTotal - openCost;
    const net = unreal + realized + dividends - feeOther; // buy/sell fees are already inside cost basis / proceeds
    const avgInv = (() => { const v = out.invested.filter(x => x > 0); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; })();
    const irr = xirr([...flows, { t: Date.now(), v: total - cashTotal }]);
    const r1 = rets.slice(-365), mean = r1.reduce((s, x) => s + x, 0) / (r1.length || 1);
    const vol = r1.length > 20 ? Math.sqrt(r1.reduce((s, x) => s + (x - mean) ** 2, 0) / (r1.length - 1)) * Math.sqrt(365) * 100 : null;
    let peak = 0, mdd = 0; for (const v of out.index) { peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1); }
    let beta = null;
    if (bRets.length > 20) { const n = Math.min(rets.length, bRets.length), a = rets.slice(-n), b = bRets.slice(-n), ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n; let cov = 0, vb = 0; for (let i = 0; i < n; i++) { cov += (a[i] - ma) * (b[i] - mb); vb += (b[i] - mb) ** 2; } beta = vb ? cov / vb : null; }
    // dividends by month (base, at payment FX)
    const divMonths = {};
    acts.filter(a => a.type === 'DIVIDEND' || a.type === 'INTEREST').forEach(a => { const i = days.indexOf(a.date); const amt = a.qty * a.price * fxAt(a.currency, i < 0 ? li : i); divMonths[a.date.slice(0, 7)] = (divMonths[a.date.slice(0, 7)] || 0) + amt; });
    // downsample series
    const step = Math.max(1, Math.ceil(out.t.length / 700)), ds = {};
    for (const k of Object.keys(out)) ds[k] = out[k].filter((_, i) => i % step === 0 || i === out[k].length - 1);
    const twr = idx - 1, years = days.length / 365;
    return {
      base, bench, today, first, days: days.length, updated: Date.now(), source: { type: ext.source, syncedAt: ext.syncedAt, url: ext.url || null, error: ext.error || null, external: (ext.activities || []).length, manual: acts.filter(a => a.source === 'manual').length },
      summary: {
        value: total, cash: cashTotal, invested: openCost, netInvested: invested, unrealized: unreal, realized, dividends, fees, net, dayChange: dayChg, dayPct: total - dayChg ? dayChg / (total - dayChg) * 100 : 0,
        roai: avgInv ? net / avgInv * 100 : null, simple: openCost ? unreal / openCost * 100 : null, twr: twr * 100, twrAnn: years >= 1 ? (Math.pow(1 + twr, 1 / years) - 1) * 100 : null, irr: irr != null ? irr * 100 : null,
        vol, mdd: mdd * 100, sharpe: vol && irr != null ? (irr * 100 - 4) / vol : null, beta, projDiv, projYield: total ? projDiv / total * 100 : null,
        benchValue: out.benchValue[out.benchValue.length - 1], gf: ext.gfPerformance || null,
      },
      holdings, closed, alloc, series: ds, divMonths, warnings, unknown: ext.unknown || [],
    };
  });
}

// ───────────────────────────── Own Bitcoin node (RPC) ─────────────────────────────
function btcConf() {
  const s = (state.settings && state.settings.bitcoin) || {};
  const host = process.env.BITCOIN_RPC_HOST, port = process.env.BITCOIN_RPC_PORT || '8332';
  const url = String(s.rpcUrl || (host ? `http://${host}:${port}` : '')).trim().replace(/\/+$/, '');
  const user = s.rpcUser || process.env.BITCOIN_RPC_USER || '', pass = s.rpcPass || process.env.BITCOIN_RPC_PASS || '';
  return /^https?:\/\//.test(url) && user && pass ? { url, user, pass, fromEnv: !s.rpcUrl && !!host } : null;
}
async function btcRpc(method, params = []) {
  const c = btcConf();
  if (!c) throw Object.assign(new Error('Bitcoin uzel není nastaven'), { status: 404 });
  const r = await fetchRaw(c.url, { method: 'POST', timeout: 12000, headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(c.user + ':' + c.pass).toString('base64') }, body: JSON.stringify({ jsonrpc: '1.0', id: 'finterm', method, params }) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.error) throw new Error((j && j.error && j.error.message) || 'RPC HTTP ' + r.status);
  return j.result;
}
function getNodeInfo() {
  return cached('btcnode', 20e3, async () => {
    const [bc, net, mp, up, mi, fees] = await Promise.all([
      btcRpc('getblockchaininfo'), btcRpc('getnetworkinfo').catch(() => null), btcRpc('getmempoolinfo').catch(() => null), btcRpc('uptime').catch(() => null),
      btcRpc('getmininginfo').catch(() => null), Promise.all([1, 3, 6, 144].map(b => btcRpc('estimatesmartfee', [b]).then(x => (x && x.feerate ? +(x.feerate * 1e5).toFixed(1) : null)).catch(() => null))),
    ]);
    mark('node', true);
    return {
      chain: bc.chain, blocks: bc.blocks, headers: bc.headers, progress: bc.verificationprogress, ibd: bc.initialblockdownload, size: bc.size_on_disk, pruned: bc.pruned, time: bc.time ? bc.time * 1000 : null, difficulty: bc.difficulty,
      version: net && net.subversion, connections: net && net.connections, inbound: net && net.connections_in, outbound: net && net.connections_out,
      networks: net && (net.networks || []).filter(n => n.reachable).map(n => n.name), mempool: mp && { size: mp.size, bytes: mp.bytes, usage: mp.usage, minfee: mp.mempoolminfee ? +(mp.mempoolminfee * 1e5).toFixed(2) : null, total: mp.total_fee },
      uptime: up, hashps: mi && mi.networkhashps, fees: { fast: fees[0], m30: fees[1], h1: fees[2], day: fees[3] },
    };
  });
}

// local mempool (Umbrel app) auto-detection – internal docker DNS bypasses the app proxy
let mempoolLocal = null;
async function detectMempool() {
  // Umbrel mempool app: web 10.21.21.26:3006 (container mempool_web_1), backend API 10.21.21.27:8999
  const cands = [process.env.MEMPOOL_LOCAL, 'http://mempool_web_1:3006', 'http://10.21.21.26:3006', 'http://mempool_api_1:8999', 'http://10.21.21.27:8999'].filter(Boolean);
  for (const c of cands) {
    try { const r = await fetchRaw(c + '/api/blocks/tip/height', { timeout: 3000 }); if (r.ok && /^\d+$/.test((await r.text()).trim())) { if (mempoolLocal !== c) log('local mempool detected at', c); mempoolLocal = c; return; } } catch { /* not present */ }
  }
  mempoolLocal = null;
}

// secrets are never sent back to the browser
const SECRET_PATHS = [['ghostfolio', 'token'], ['bitcoin', 'rpcPass'], ['notify', 'telegramToken'], ['notify', 'ntfyToken']];
const MASK = '••••••••';
function maskSettings(s) {
  if (!s || typeof s !== 'object') return s;
  const c = JSON.parse(JSON.stringify(s));
  for (const [a, b] of SECRET_PATHS) if (c[a] && c[a][b]) c[a][b] = MASK;
  return c;
}
function keepSecrets(next, prev) {
  for (const [a, b] of SECRET_PATHS) if (next && next[a] && next[a][b] === MASK) next[a][b] = prev && prev[a] ? prev[a][b] : '';
  return next;
}

// ───────────────────────────── State storage ─────────────────────────────
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const STATE_KEYS = new Set(['portfolio', 'watchlist', 'alerts', 'journal', 'settings', 'links', 'layout', 'notes']);
let state = {};
let dataWritable = true;
function writeJSONAtomic(file, obj) {
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
    dataWritable = true;
  } catch (e) {
    dataWritable = false;
    log('write failed', file, e.message);
  }
}
function loadState() {
  for (const f of [STATE_FILE, STATE_FILE + '.bak']) {
    try { state = JSON.parse(fs.readFileSync(f, 'utf8')); if (f !== STATE_FILE) log('state restored from backup'); return; } catch (e) { if (e.code !== 'ENOENT') log('state load failed', f, e.message); }
  }
  state = {};
}
let saveTimer = null;
function saveState(delay = 1000) { clearTimeout(saveTimer); saveTimer = setTimeout(flushState, delay); }
function flushState() { clearTimeout(saveTimer); saveTimer = null; writeJSONAtomic(STATE_FILE, state); }
setInterval(() => { try { if (fs.existsSync(STATE_FILE)) fs.copyFileSync(STATE_FILE, STATE_FILE + '.bak'); } catch {} }, 12 * 3600e3).unref();

// ───────────────────────────── HTTP server ─────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const staticCache = new Map();
async function serveStatic(req, res, rel) {
  const fp = path.join(PUBLIC_DIR, rel);
  if (!fp.startsWith(PUBLIC_DIR)) return sendJSON(req, res, 403, { error: 'forbidden' });
  let st;
  try { st = await fsp.stat(fp); if (!st.isFile()) throw new Error(); } catch { return sendJSON(req, res, 404, { error: 'not found' }); }
  let c = staticCache.get(fp);
  if (!c || c.mtime !== st.mtimeMs) {
    const raw = await fsp.readFile(fp);
    c = { mtime: st.mtimeMs, raw, gz: zlib.gzipSync(raw, { level: 9 }), etag: `"${hash(raw)}"`, type: MIME[path.extname(fp)] || 'application/octet-stream' };
    staticCache.set(fp, c);
  }
  if (req.headers['if-none-match'] === c.etag) { res.writeHead(304, { ETag: c.etag }); return res.end(); }
  const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const body = gz ? c.gz : c.raw;
  res.writeHead(200, {
    'Content-Type': c.type, 'Content-Length': body.length, ETag: c.etag, 'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff', ...(gz ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function sendJSON(req, res, status, obj) {
  let body = Buffer.from(JSON.stringify(obj));
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (body.length > 1400 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    body = zlib.gzipSync(body, { level: 5 });
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  }
  headers['Content-Length'] = body.length;
  res.writeHead(status, headers);
  res.end(body);
}

function readBody(req, limit = 3e6) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('payload too large'), { status: 413 })); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJSON(req) {
  const txt = await readBody(req);
  try { return JSON.parse(txt || 'null'); } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
}

let lastClient = 0;
const routes = {
  'GET /api/status': async () => ({
    ok: true, version: VERSION, uptime: Math.round((Date.now() - STARTED) / 1000), node: process.version,
    memory: Math.round(process.memoryUsage().rss / 1048576), dataWritable, dataDir: DATA_DIR, cache: cache.size,
    sources: health, time: Date.now(), newsUpdated, archive: Object.keys(archive.events).length,
    mempool: mempoolBase(), mempoolLocal: !!mempoolLocal, node: !!btcConf(), portfolioSource: ext.source, portfolioSynced: ext.syncedAt,
  }),
  'GET /api/quotes': async q => getQuotes(cleanSymbols(q.get('s'))),
  'GET /api/spark': async q => getSpark(cleanSymbols(q.get('s'), 80), RANGES.has(q.get('range')) ? q.get('range') : '1d', INTERVALS.has(q.get('interval')) ? q.get('interval') : '15m'),
  'GET /api/chart': async q => {
    const [s] = cleanSymbols(q.get('s'), 1);
    if (!s) throw Object.assign(new Error('missing symbol'), { status: 400 });
    return getChart(s, RANGES.has(q.get('range')) ? q.get('range') : '1mo', INTERVALS.has(q.get('interval')) ? q.get('interval') : '1d');
  },
  'GET /api/search': async q => { const t = String(q.get('q') || '').trim().slice(0, 40); return t.length < 1 ? [] : ySearch(t); },
  'GET /api/perf': async q => getPerf(cleanSymbols(q.get('s'), 40)),
  'GET /api/portfolio/analysis': async q => {
    const base = ['CZK', 'USD', 'EUR', 'GBP', 'CHF'].includes(q.get('base')) ? q.get('base') : (state.settings && state.settings.baseCurrency) || 'CZK';
    const [bench] = cleanSymbols(q.get('bench') || '^GSPC', 1);
    return portfolioAnalysis(base, bench || '^GSPC');
  },
  'GET /api/portfolio/source': async () => ({ source: ext.source, syncedAt: ext.syncedAt, url: ext.url || null, error: ext.error || null, activities: (ext.activities || []).length, accounts: ext.accounts || [], unknown: ext.unknown || [], baseCurrency: ext.baseCurrency || null, configured: !!(state.settings && state.settings.ghostfolio && state.settings.ghostfolio.token) }),
  'GET /api/portfolio/activities': async () => allActivities(),
  'POST /api/portfolio/import': async (q, req) => {
    const body = await readJSON(req);
    const conv = await convertGhostfolio(body && body.data ? body.data : body);
    ext = { ...conv, source: 'ghostfolio-file', syncedAt: Date.now(), url: null, error: null, gfPerformance: null };
    saveExt();
    return { ok: true, activities: conv.activities.length, accounts: conv.accounts.length, unknown: conv.unknown };
  },
  'POST /api/portfolio/ghostfolio/sync': async () => ghostfolioSync(),
  'POST /api/portfolio/external/clear': async () => { ext = { activities: [], accounts: [], source: null, syncedAt: null }; saveExt(); return { ok: true }; },
  'GET /api/node': async () => {
    const c = btcConf();
    if (!c) return { configured: false };
    try { return { configured: true, fromEnv: c.fromEnv, ...(await getNodeInfo()) }; }
    catch (e) { mark('node', false, e.message); return { configured: true, error: e.message }; }
  },
  'GET /api/fundamentals': async q => {
    const [s] = cleanSymbols(q.get('s'), 1);
    if (!s) throw Object.assign(new Error('missing symbol'), { status: 400 });
    return getFundamentals(s);
  },
  'GET /api/corr': async q => getCorr(cleanSymbols(q.get('s'), 16), Math.max(20, Math.min(480, parseInt(q.get('days') || '90', 10) || 90))),
  'GET /api/fx': async () => cached('fx', 60e3, getFx),
  'GET /api/cb': async () => getCentralBanks(),
  'GET /api/macro': async () => getMacro(),
  'GET /api/macro/series': async q => {
    const m = MACRO.find(x => x.key === q.get('key'));
    if (!m) throw Object.assign(new Error('unknown indicator'), { status: 404 });
    const from = /^\d{4}-\d{2}-\d{2}$/.test(q.get('from') || '') ? q.get('from') : '2005-01-01';
    return { ...m, data: await macroSeries(m, from) };
  },
  'GET /api/fred': async q => {
    const from = /^\d{4}-\d{2}-\d{2}$/.test(q.get('from') || '') ? q.get('from') : '2015-01-01';
    return { id: q.get('id'), data: transform(await fred(String(q.get('id') || ''), from), q.get('tf')) };
  },
  'GET /api/curve': async () => getCurve(),
  'GET /api/calendar': async () => getCalendar(),
  'GET /api/crypto/markets': async () => getCryptoMarkets(),
  'GET /api/crypto/global': async () => cached('cryptoglobal', 60e3, getCryptoGlobal),
  'GET /api/fng': async () => getStockFng(),
  'GET /api/mempool': async () => getMempool(),
  'GET /api/news': async q => {
    const items = await getNews();
    const cats = (q.get('cat') || '').split(',').filter(Boolean);
    const regions = (q.get('region') || '').split(',').filter(Boolean);
    const text = (q.get('q') || '').toLowerCase();
    const min = parseInt(q.get('min') || '0', 10) || 0;
    const limit = Math.min(1200, parseInt(q.get('limit') || '600', 10) || 600);
    const out = items.filter(i => (!cats.length || cats.includes(i.cat)) && (!regions.length || regions.includes(i.region)) && i.score >= min &&
      (!text || (i.title + ' ' + i.summary).toLowerCase().includes(text))).slice(0, limit);
    return { items: out, updated: newsUpdated, total: items.length };
  },
  'GET /api/news/feeds': async () => allFeeds().map(f => ({ id: f.id, name: f.name, cat: f.cat, region: f.region, url: f.url, enabled: f.enabled, custom: !!f.custom, status: feedStatus[f.id] || null })),
  'POST /api/news/refresh': async () => { cache.forEach((v, k) => { if (k.startsWith('feed:')) cache.delete(k); }); await refreshNews(); return { ok: true, count: newsItems.length }; },
  // since=-1 (or missing) → only returns the current sequence number (client baseline)
  'GET /api/events': async q => { const since = parseInt(q.get('since') ?? '-1', 10); return { last: eventSeq, events: since >= 0 ? events.filter(e => e.id > since) : [] }; },
  'GET /api/state': async () => ({ ...state, settings: maskSettings(state.settings), _server: { version: VERSION, writable: dataWritable } }),
  'POST /api/notify/test': async () => {
    const r = await notifyAll('FinTerm – test notifikace', 'Pokud vidíte tuto zprávu, notifikace fungují. ✅', { tags: 'white_check_mark' });
    return { results: r, configured: r.length };
  },
};

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (BASIC_AUTH) {
    const given = Buffer.from((req.headers.authorization || '').replace(/^Basic\s+/i, ''), 'base64').toString();
    const a = Buffer.from(given), b = Buffer.from(BASIC_AUTH);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="FinTerm"', 'Content-Type': 'text/plain' });
      return res.end('Authentication required');
    }
  }

  if (!p.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJSON(req, res, 405, { error: 'method not allowed' });
    const rel = p === '/' ? 'index.html' : p === '/favicon.ico' ? 'icon.svg' : decodeURIComponent(p.slice(1));
    if (!/^[\w.\-]+$/.test(rel)) return sendJSON(req, res, 404, { error: 'not found' });
    return serveStatic(req, res, rel);
  }

  lastClient = Date.now();
  try {
    const stateKey = p.match(/^\/api\/state\/([a-z]+)$/);
    if (stateKey) {
      const key = stateKey[1];
      if (!STATE_KEYS.has(key)) return sendJSON(req, res, 404, { error: 'unknown key' });
      if (req.method === 'GET') return sendJSON(req, res, 200, (key === 'settings' ? maskSettings(state[key]) : state[key]) ?? null);
      if (req.method === 'PUT') {
        const body = await readJSON(req);
        if (body === null || typeof body !== 'object') return sendJSON(req, res, 400, { error: 'object expected' });
        state[key] = key === 'settings' ? keepSecrets(body, state.settings) : body;
        saveState();
        if (key === 'settings') cache.forEach((v, k) => { if (k === 'cryptoglobal' || k === 'btcnode' || k.startsWith('mempool:') || k.startsWith('pfa:')) cache.delete(k); });
        if (key === 'portfolio') cache.forEach((v, k) => { if (k.startsWith('pfa:')) cache.delete(k); });
        return sendJSON(req, res, 200, { ok: true, writable: dataWritable });
      }
      return sendJSON(req, res, 405, { error: 'method not allowed' });
    }
    const fn = routes[`${req.method} ${p}`];
    if (!fn) return sendJSON(req, res, 404, { error: 'unknown endpoint' });
    const out = await fn(url.searchParams, req);
    return sendJSON(req, res, 200, out);
  } catch (e) {
    const status = e.status && e.status < 500 ? e.status : 502;
    if (status >= 500) log('API error', p, e.message);
    return sendJSON(req, res, status, { error: e.message || 'error' });
  }
}

// ───────────────────────────── boot ─────────────────────────────
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { log('cannot create data dir', DATA_DIR, e.message); }
loadState();
loadArchive();
loadExt();

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => { log('fatal handler error', e); try { sendJSON(req, res, 500, { error: 'internal error' }); } catch {} });
});
server.keepAliveTimeout = 65e3;
server.listen(PORT, HOST, () => {
  log(`FinTerm ${VERSION} listening on http://${HOST}:${PORT}  (data: ${DATA_DIR})`);
  setTimeout(() => { getFF().catch(() => {}); refreshNews().catch(() => {}); getMacro().catch(() => {}); getCentralBanks().catch(() => {}); }, 1500);
});

// background jobs
setInterval(() => runAlerts().catch(e => log('alerts', e.message)), 60e3).unref();
setInterval(() => {
  const active = Date.now() - lastClient < 30 * 60e3;
  if (active || state.settings?.notify?.breaking) refreshNews().catch(() => {});
}, 4 * 60e3).unref();
setInterval(() => getFF().catch(e => mark('ff', false, e.message)), 60 * 60e3).unref();
// own infrastructure: local mempool detection, Ghostfolio auto-sync
setTimeout(() => detectMempool().catch(() => {}), 1000);
setInterval(() => detectMempool().catch(() => {}), 10 * 60e3).unref();
const gfAuto = () => { const g = (state.settings && state.settings.ghostfolio) || {}; if (g.token && g.autoSync !== false) ghostfolioSync().catch(e => log('ghostfolio sync:', e.message)); };
setTimeout(gfAuto, 6000);
setInterval(gfAuto, 30 * 60e3).unref();

process.on('unhandledRejection', e => log('unhandledRejection', e && e.message));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('shutting down…');
    flushState();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
