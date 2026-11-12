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
const https = require('https');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');

const VERSION = '1.5.0';
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
// ttl may be a function of the value (degraded results, e.g. with a stale FX rate, are kept only briefly).
const cache = new Map();
const inflight = new Map();
async function cached(key, ttl, fn, staleMax = 72 * 3600e3) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < (hit.ttl ?? ttl)) return hit.v;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const v = await fn();
      cache.set(key, { v, t: Date.now(), ttl: typeof ttl === 'function' ? ttl(v) : ttl });
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
  for (const [k, v] of cache) if (now - v.t > 72 * 3600e3 || (k.startsWith('pfa:') && now - v.t > 30 * 60e3)) cache.delete(k);
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
function isPrivateV4(ip) {
  const [a, b, c] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99) || (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
}
// IPv6 as 8 numbers (any notation: "::", embedded dotted IPv4, zone id); null when not parseable
function v6Words(ip) {
  let s = String(ip).toLowerCase().replace(/%.*$/, '');
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) { if (!net.isIPv4(m[2])) return null; const p = m[2].split('.').map(Number); s = m[1] + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16); }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const part = h => (h ? h.split(':') : []);
  const head = part(halves[0]), tail = halves.length === 2 ? part(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const words = [...head, ...Array(fill).fill('0'), ...tail].map(w => (/^[0-9a-f]{1,4}$/.test(w) ? parseInt(w, 16) : NaN));
  return words.length === 8 && words.every(Number.isFinite) ? words : null;
}
const v4From = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateV4(ip);
  const w = v6Words(ip);
  if (!w) return true; // unknown format: blocked
  const zero = n => w.slice(0, n).every(x => x === 0);
  if (zero(8)) return true;                                          // ::
  if (zero(5) && w[5] === 0xffff) return isPrivateV4(v4From(w[6], w[7])); // ::ffff:a.b.c.d (IPv4-mapped, any notation)
  if (zero(4) && w[4] === 0xffff && w[5] === 0) return isPrivateV4(v4From(w[6], w[7])); // ::ffff:0:a.b.c.d (translated)
  if (zero(6)) return true;                                          // ::1 and IPv4-compatible ::a.b.c.d
  if (w[0] === 0x64 && w[1] === 0xff9b) return w[2] !== 0 || w[3] !== 0 || w[4] !== 0 || w[5] !== 0 || isPrivateV4(v4From(w[6], w[7])); // NAT64 64:ff9b::/96; local-use 64:ff9b:1::/48 blocked
  if (w[0] === 0x2002) return isPrivateV4(v4From(w[1], w[2]));      // 6to4 carries an IPv4
  if (w[0] === 0x2001 && w[1] === 0) return true;                    // Teredo
  if (w[0] === 0x2001 && w[1] === 0xdb8) return true;                // documentation
  if (w[0] === 0x100 && w[1] === 0 && w[2] === 0 && w[3] === 0) return true; // discard 100::/64
  return (w[0] & 0xfe00) === 0xfc00 || (w[0] & 0xffc0) === 0xfe80 || (w[0] & 0xffc0) === 0xfec0 || (w[0] & 0xff00) === 0xff00; // ULA, link/site-local, multicast
}
// resolves the host once, checks every address and returns the one to connect to (DNS rebinding: the request is pinned to it)
async function assertPublicUrl(u) {
  const url = new URL(u);
  if (!/^https?:$/.test(url.protocol)) throw new Error('only http(s) URLs are allowed');
  if (ALLOW_PRIVATE_FEEDS) return { url, addr: null };
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true, verbatim: true });
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new Error('private network address blocked');
  return { url, addr: addrs[0] };
}
// GET over http(s) connected to the verified address (TLS still checks the host name); gzip/deflate/br, size limit.
// timeout is the deadline for the whole request: the socket timeout alone only measures idle time, so a server dripping
// a byte every few seconds would hold the request (and the news refresh waiting for it) for minutes
function requestPinned(url, addr, { timeout = 15000, headers = {}, maxBytes = 5e6 } = {}) {
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let body = null, done = false, timer = null;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
    const fail = e => { req.destroy(e); if (body) body.destroy(); finish(reject, e); };
    const req = mod.request(url, {
      method: 'GET', timeout,
      headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9,cs;q=0.8', 'Accept-Encoding': 'gzip, deflate, br', ...headers },
      lookup: (hostname, o, cb) => (o && o.all ? cb(null, [{ address: addr.address, family: addr.family }]) : cb(null, addr.address, addr.family)),
    }, res => {
      const enc = String(res.headers['content-encoding'] || '').toLowerCase().trim();
      body = enc === 'gzip' || enc === 'x-gzip' ? res.pipe(zlib.createGunzip()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : enc === 'br' ? res.pipe(zlib.createBrotliDecompress()) : res;
      const chunks = [];
      let size = 0;
      body.on('data', c => { size += c.length; if (size > maxBytes) fail(new Error('response too large')); else chunks.push(c); });
      body.on('end', () => finish(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      body.on('error', e => finish(reject, e));
      res.on('close', () => { if (!res.complete) finish(reject, new Error('connection closed early')); });
    });
    timer = setTimeout(() => fail(new Error('timeout')), timeout);
    req.on('timeout', () => fail(new Error('timeout')));
    req.on('error', e => finish(reject, e));
    req.end();
  });
}
async function fetchPublicText(u, opts = {}) {
  let url = u;
  for (let i = 0; i < 4; i++) {
    const { url: parsed, addr } = await assertPublicUrl(url);
    if (!addr) { // ALLOW_PRIVATE_FEEDS: plain fetch
      const r = await fetchRaw(url, { ...opts, redirect: 'manual' });
      const loc = r.headers.get('location');
      if (r.status >= 300 && r.status < 400 && loc) { url = new URL(loc, url).href; continue; }
      if (!r.ok) throw new HttpError(r.status, url);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 5e6) throw new Error('response too large');
      return decodeBody(buf, r.headers.get('content-type') || '');
    }
    const r = await requestPinned(parsed, addr, { timeout: opts.timeout, headers: opts.headers });
    const loc = r.headers.location;
    if (r.status >= 300 && r.status < 400 && loc) { url = new URL(loc, url).href; continue; }
    if (r.status < 200 || r.status >= 300) throw new HttpError(r.status, url);
    return decodeBody(r.body, String(r.headers['content-type'] || ''));
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

// Yahoo names: the long name wins, without Yahoo's padding and listing codes ("GEA Group AG      I", "PKN C.XWAR PLN")
const NAME_JUNK = [
  /\s{2,}[A-Za-z]{1,2}\s*$/,                  // share class / listing letter after padding
  /\s+C\.X[A-Z]{3,4}\s+[A-Z]{3}\s*$/,         // Warsaw "C.XWAR PLN", "C.XGLO PLN"
  /\s+ORD\s+(?:SHS|[A-Z]{3}\s*[\d.,]+)\s*$/i, // "ORD USD0.20", "ORD SHS"
  /\s+EO\s+[-\d,.]+\s*$/,                     // "EO 0,3" (nominal value in euro)
];
function cleanName(s) {
  if (s == null) return '';
  let t = decodeEntities(String(s));
  for (const re of NAME_JUNK) t = t.replace(re, '');
  return t.replace(/\s+/g, ' ').trim();
}
const qName = q => cleanName(q.longName) || cleanName(q.shortName) || q.displayName || q.symbol;
// Yahoo's forward dividend yield is sometimes far off (Samsung ~9 %: the last special dividend × 4). The trailing yield is
// never a substitute: for GBp listings Yahoo divides the GBP dividend by the GBp price (VOD.L 0.04 % instead of 3.4 %).
// A forward yield of 3 % or more (or none, with a trailing dividend) is checked in getQuotes against the dividends really
// paid in the last 12 months (chart events in the unit of the price, cached 24 h): forward more than 1.5× the paid yield →
// the paid yield. The chart counts only when it is complete (divChartOk): Yahoo's monthly chart misses the latest payments
// of some ADRs (INFY), others have none at all (TM, SONY, HDB).
const divSuspect = new Set();
function divYieldOf(q) {
  const fwd = Number.isFinite(q.dividendYield) ? q.dividendYield : null;
  if (q.symbol && (fwd >= 3 || (fwd == null && (q.trailingAnnualDividendRate > 0 || q.trailingAnnualDividendYield > 0)))) divSuspect.add(String(q.symbol).toUpperCase());
  return fwd ?? undefined;
}
// both dividend lookups below: one request per symbol at a time (cached() shares a request in flight – the stock page asks for
// the same quote several times at once), a result is kept for a day, a failed request for 10 minutes (then it is retried)
const DIV_TTL = r => (r.err ? 10 * 60e3 : 24 * 3600e3);
// dividends paid in the last 12 months: { sum (unit of the price), times: [payment ms, ascending] } or null without events
// (unknown, not zero)
function trailDivSum(sym) {
  return cached('divsum:' + sym, DIV_TTL, async () => {
    try {
      const j = await yahooJSON(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1y&interval=1mo&events=div`);
      const ev = Object.values(j?.chart?.result?.[0]?.events?.dividends || {}).filter(x => +x.amount > 0 && x.date > 0);
      return { v: ev.length ? { sum: ev.reduce((s, x) => s + +x.amount, 0), times: ev.map(x => x.date * 1000).sort((a, b) => a - b) } : null };
    } catch { return { v: null, err: true }; }
  }).then(r => r.v);
}
// the last (or announced) ex-dividend date from summaryDetail; null = Yahoo has none, undefined = request failed (an error of
// quoteSummary is kept too: no new request with every quote refresh)
function lastExDiv(sym) {
  return cached('exdiv:' + sym, DIV_TTL, async () => {
    try {
      const j = await yahooJSON(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=summaryDetail`);
      const x = j?.quoteSummary?.result?.[0]?.summaryDetail?.exDividendDate, s = x && typeof x === 'object' ? x.raw : x;
      return { v: Number.isFinite(s) && s > 0 ? s * 1000 : null };
    } catch { return { v: undefined, err: true }; }
  }).then(r => r.v);
}
// is the chart complete? Its last payment may be at most ~10 days older than the last ex-dividend date; an announced
// (future) ex-date is compared with the usual spacing of the chart's payments (needs two of them)
function divChartOk(info, exd, now = Date.now()) {
  if (!info || !info.times.length) return false;
  if (exd == null) return true; // Yahoo knows no ex-date: nothing to compare with
  const last = info.times[info.times.length - 1];
  if (exd <= now) return last >= exd - 10 * 864e5;
  const gaps = info.times.slice(1).map((t, i) => t - info.times[i]).sort((a, b) => a - b);
  return gaps.length > 0 && exd - last <= gaps[Math.floor(gaps.length / 2)] * 1.5 + 10 * 864e5;
}
async function fixDivYields(out) {
  const sus = Object.keys(out).filter(s => divSuspect.has(s) && out[s] && out[s].price > 0);
  if (!sus.length) return;
  // at most 4 symbols at a time: the first load of a long watchlist would otherwise send dozens of chart requests at once
  await Promise.race([mapLimit(sus, 4, async s => {
    const q = out[s], info = await trailDivSum(s);
    if (!info || !(info.sum > 0)) return;
    const paid = info.sum / q.price * 100;
    if (q.divYield != null && !(q.divYield > 1.5 * paid)) return; // plausible: the forward yield stays
    const exd = await lastExDiv(s);
    if (exd !== undefined && divChartOk(info, exd)) q.divYield = paid;
  }), new Promise(r => setTimeout(r, 4000))]);
}

function normQuote(q) {
  const price = q.regularMarketPrice;
  const prev = q.regularMarketPreviousClose ?? null;
  return {
    symbol: q.symbol, name: qName(q), longName: q.longName,
    price, prevClose: prev,
    change: q.regularMarketChange ?? (prev != null ? price - prev : null),
    changePct: q.regularMarketChangePercent ?? (prev ? (price / prev - 1) * 100 : null),
    open: q.regularMarketOpen, high: q.regularMarketDayHigh, low: q.regularMarketDayLow,
    volume: q.regularMarketVolume, avgVolume: q.averageDailyVolume3Month, marketCap: q.marketCap,
    currency: q.currency, marketState: q.marketState, time: q.regularMarketTime ? q.regularMarketTime * 1000 : null,
    exchange: q.fullExchangeName || q.exchange, type: q.quoteType, tz: q.exchangeTimezoneName,
    high52: q.fiftyTwoWeekHigh, low52: q.fiftyTwoWeekLow, ma50: q.fiftyDayAverage, ma200: q.twoHundredDayAverage,
    pe: q.trailingPE, fpe: q.forwardPE, eps: q.epsTrailingTwelveMonths, fwdEps: q.epsForward, pb: q.priceToBook, bookValue: q.bookValue,
    divYield: divYieldOf(q),
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
    symbol: m.symbol, name: qName(m), price, prevClose: prev,
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
  await fixDivYields(out);
  return out;
}

const RANGES = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max']);
const INTERVALS = new Set(['1m', '2m', '5m', '15m', '30m', '60m', '90m', '1h', '1d', '5d', '1wk', '1mo', '3mo']);

function getChart(sym, range = '1mo', interval = '1d', divs = false) {
  const intraday = /[mh]$/.test(interval) && interval !== '1mo' && interval !== '3mo';
  return cached(`chart:${sym}:${range}:${interval}${divs && !intraday ? ':div' : ''}`, intraday ? 60e3 : 15 * 60e3, async () => {
    // daily+ charts carry the split history (closes are split-adjusted; the portfolio re-bases pre-split trades);
    // divs = the dividend events too (fundamentals: dividends paid, no separate request)
    const j = await yahooJSON(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}&includePrePost=false${intraday ? '' : divs ? '&events=div,split' : '&events=split'}`);
    const res = j?.chart?.result?.[0];
    if (!res) throw new Error(j?.chart?.error?.description || 'no chart data');
    const q = res.indicators?.quote?.[0] || {};
    const ts = res.timestamp || [];
    const splits = Object.values(res.events?.splits || {}).map(s => ({ t: s.date * 1000, num: +s.numerator, den: +s.denominator }))
      .filter(s => s.t && s.num > 0 && s.den > 0 && s.num !== s.den).sort((a, b) => a.t - b.t);
    const out = { symbol: res.meta?.symbol || sym, currency: res.meta?.currency, tz: res.meta?.exchangeTimezoneName, meta: chartMetaQuote(res.meta), t: [], o: [], h: [], l: [], c: [], v: [], splits };
    if (divs && !intraday) out.divEvents = res.events?.dividends || {};
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

// raw Yahoo search hits (no options, only instruments Yahoo itself quotes)
function ySearchRaw(q) {
  return cached('search:' + q.toLowerCase(), 3600e3, async () => {
    const j = await yahooJSON(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&listsCount=0`);
    mark('yahoo', true);
    return (j.quotes || []).filter(x => x.symbol && x.quoteType !== 'OPTION' && x.isYahooFinance !== false);
  });
}
async function ySearch(q) {
  return (await ySearchRaw(q)).map(x => ({
    symbol: x.symbol, name: cleanName(x.longname) || cleanName(x.shortname) || x.symbol, exchange: x.exchDisp || x.exchange, type: x.typeDisp || x.quoteType,
  }));
}

// ───────────────────────────── instrument resolver ─────────────────────────────
// Typed text → Yahoo instrument. An explicit symbol (. ^ = -) is verified by a quote (BRK.B → BRK-B). Anything else goes to
// Yahoo search plus one bulk quote of the text on the main exchanges. Candidates are listings whose ticker equals the text
// or whose name starts with it. Listings of one firm resolve to the home listing; firms that hold the same ticker on main
// exchanges (ALV = Allianz / Autoliv) are returned as a choice. Never options, always with a price.
const MAIN_SFX = ['DE', 'PA', 'AS', 'BR', 'MI', 'MC', 'LS', 'SW', 'L', 'IR', 'VI', 'PR', 'WA', 'BD', 'ST', 'CO', 'HE', 'OL', 'T', 'HK', 'KS', 'KQ', 'TW', 'TWO', 'SS', 'SZ', 'NS', 'BO', 'AX', 'NZ', 'TO', 'SA', 'MX', 'JO', 'TA', 'SI'];
const MAIN_SET = new Set(MAIN_SFX);
const SEC_DE = new Set(['F', 'BE', 'DU', 'HM', 'HA', 'MU', 'SG']); // secondary German venues: only after the primary listings
// home exchanges by the company's country (Yahoo assetProfile); '' = USA
const HOME_SFX = {
  'United States': [''], 'United Kingdom': ['L'], Jersey: ['L'], Guernsey: ['L'], 'Isle of Man': ['L'], Ireland: ['IR', 'L'], Germany: ['DE'], France: ['PA'], Netherlands: ['AS'],
  Belgium: ['BR'], Portugal: ['LS'], Italy: ['MI'], Spain: ['MC'], Switzerland: ['SW'], Austria: ['VI'], 'Czech Republic': ['PR'], Czechia: ['PR'], Poland: ['WA'], Hungary: ['BD'],
  Sweden: ['ST'], Denmark: ['CO'], Finland: ['HE'], Norway: ['OL'], Japan: ['T'], 'South Korea': ['KS', 'KQ'], Korea: ['KS', 'KQ'], Taiwan: ['TW', 'TWO'], 'Hong Kong': ['HK'],
  China: ['HK', 'SS', 'SZ'], India: ['NS', 'BO'], Australia: ['AX'], 'New Zealand': ['NZ'], Canada: ['TO', 'V'], Brazil: ['SA'], Mexico: ['MX'], 'South Africa': ['JO'],
  Israel: ['TA'], Singapore: ['SI'],
};
const sfxOf = s => (/\.([A-Z]{1,3})$/.exec(s) || [])[1] || '';
const deaccent = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const nameToks = s => deaccent(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
// legal forms (also spelled out: AG = Aktiengesellschaft, plc = public limited company, N.V. = naamloze vennootschap), share
// classes and listing words: "Siemens AG", "Siemens Aktiengesellschaft" and "SIEMENS AG NA O.N." are one name
const LEGAL_TOK = new Set(['ag', 'se', 'sa', 'nv', 'bv', 'plc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'companies', 'ltd', 'limited', 'llc', 'lp', 'holding', 'holdings', 'group',
  'spa', 'sab', 'cv', 'de', 'ab', 'asa', 'oyj', 'oy', 'kgaa', 'gmbh', 'bhd', 'berhad', 'tbk', 'pt', 'the', 'public', 'nyrt', 'publ', 'aktiengesellschaft', 'societe', 'europeenne', 'class',
  'ord', 'shs', 'registered', 'reg', 'adr', 'gdr', 'cdr', 'sponsored', 'unsponsored', 'new',
  'as', 'aktie', 'aktien', 'na', 'on', 'vna', 'inh', 'vz', 'st', 'kg', 'rt', 'ltda', 'limitada', 'saa', 'pjsc', 'ojsc', 'jsc', 'joint', 'kommanditgesellschaft', 'auf',
  'aktiebolag', 'aktiebolaget', 'aktieselskab', 'aktieselskabet', 'allmennaksjeselskap', 'osakeyhtio', 'julkinen', 'naamloze', 'vennootschap', 'anonyme', 'sociedad', 'anonima',
  'societas', 'europaea', 'akciova', 'spolecnost', 'kabushiki', 'kaisha']);
const firmToks = s => nameToks(s).filter(t => t.length > 1 && !LEGAL_TOK.has(t));
const tokKey = ft => [...new Set(ft)].sort().join(' ');
const domesticCur = c => !!(c.finCur && c.currency && unitNorm(c.currency)[0] === c.finCur);
const isOtc = r => /OTC|Pink/i.test(r.fullExchangeName || '') || ['PNK', 'OQB', 'OQX', 'OEM', 'OGM', 'OBB'].includes(r.exchange);
// one bulk quote, no per-symbol fallback (a missing symbol simply does not exist); also refreshes the quote cache
async function quoteRaw(list) {
  const out = {};
  await Promise.all(chunk([...new Set(list)], 50).map(async ch => {
    const j = await yahooJSON(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(ch.join(','))}`);
    for (const r of j?.quoteResponse?.result || []) {
      if (!r || !r.symbol || r.regularMarketPrice == null) continue;
      const S = r.symbol.toUpperCase();
      out[S] = r;
      quoteCache.set(S, { q: normQuote(r), t: Date.now() });
    }
  }));
  mark('yahoo', true);
  return out;
}
const pub = c => ({ symbol: c.symbol, name: c.name, exchange: c.exchange, currency: c.currency, type: c.type, domestic: !!c.domestic, ...(c.mcapUsd ? { mcapUsd: Math.round(c.mcapUsd) } : {}) });
// listings of one firm: the same significant name tokens (legal forms aside) and reporting currency. Siemens AG, Siemens
// Energy and Siemens Healthineers are three firms; Siemens Ltd (India) reports in INR and is a fourth.
function sameFirm(a, b) {
  if (a.finCur && b.finCur && a.finCur !== b.finCur) return false;
  if (a.fk && a.fk === b.fk) return true;
  // one firm under two names (GE Aerospace / General Electric): same reporting currency, market cap within 10 % and neither
  // name containing the other (Siemens / Siemens Energy stay two firms whatever their size)
  if (!(a.mcapUsd && b.mcapUsd && a.finCur && b.finCur && Math.abs(Math.log(a.mcapUsd / b.mcapUsd)) < Math.log(1.1))) return false;
  const A = new Set(a.ft), B = new Set(b.ft);
  return !a.ft.every(t => B.has(t)) && !b.ft.every(t => A.has(t));
}
const byRank = (a, b) => a.rank - b.rank || a.tier - b.tier || a.ord - b.ord || a.symbol.localeCompare(b.symbol);
const byTier = (a, b) => a.tier - b.tier || byRank(a, b);
// home listing of one firm, chosen from all its listings: the company's country (one cached profile request), else quote
// currency = reporting currency; primary venues before the secondary German ones (SIE.DE, never SIE.HA). On the same venue
// tier a listing whose ticker is exactly the text comes first: share classes are one firm and Yahoo's order must not swap
// them (VOW → VOW.DE, VOW3 → VOW3.DE; a name keeps Yahoo's order: Volkswagen → VOW3.DE). Only the chosen listing is marked
// domestic – the flag belongs to its own firm
function preferredListing(f, country) {
  const ord = [...f].sort((a, b) => a.tier - b.tier || !!b.exact - !!a.exact || byRank(a, b)), home = country && HOME_SFX[country];
  const h = (home && ord.find(c => home.includes(c.sfx) && !(c.sfx === '' && c.otc))) || ord.find(c => domesticCur(c)) || null;
  ord.forEach(c => { c.domestic = c === h; });
  return h || [...f].sort(byRank)[0];
}
const timeoutP = (p, ms, fallback) => Promise.race([p, new Promise(r => setTimeout(() => r(fallback), ms))]);
const resolveDown = e => Object.assign(new Error('Vyhledávání Yahoo je nedostupné: ' + e.message), { status: 502 });
const STALE_QUOTE = 30 * 864e5; // a listing without a trade for a month (INFINEON.BD, last price 7/2024) is no candidate
// listings → firms (in Yahoo's order); every firm marks its own home listing
function groupFirms(list) {
  const firms = [];
  for (const c of [...list].sort(byRank)) { const f = firms.find(f => f.some(m => sameFirm(m, c))); if (f) f.push(c); else firms.push([c]); }
  return firms;
}

// light = while typing: Yahoo search (cached) and one bulk quote of the shown hits (≤ 8) for exchange and currency – no
// probing of exchange suffixes, no profiles, no pick; Enter or a pick runs the full resolution
async function resolveRun(q, { light = false } = {}) {
  const up = q.toUpperCase(), plain = deaccent(up);
  const out = (extra) => ({ q, pick: null, choice: null, candidates: [], exact: false, ...extra });
  const explicit = /[.^=\-]/.test(up) && SYM_RE.test(up);
  // 4. explicit symbol, verified by a quote; XXX.Y without a quote is tried as a share class XXX-Y
  if (explicit && !light) {
    const alt = /^[A-Z0-9]+\.[A-Z]$/.test(up) ? up.replace('.', '-') : null;
    let raw = await quoteRaw([up, alt].filter(Boolean)).catch(() => ({}));
    let hit = raw[up] ? up : alt && raw[alt] ? alt : null;
    if (!hit) { // the bulk endpoint misses some instruments (funds, some indices): the chart endpoint decides
      const qs = await getQuotes([up, alt].filter(Boolean)).catch(() => ({}));
      const s = qs[up] ? up : alt && qs[alt] ? alt : null;
      if (s && qs[s].price != null) {
        const n = qs[s], c = { symbol: s, name: n.name || s, exchange: n.exchange, currency: n.currency, type: n.type, domestic: false };
        return out({ pick: c, candidates: [c], exact: true, via: 'symbol' });
      }
    } else {
      const r = raw[hit], c = { symbol: hit, name: qName(r), exchange: r.fullExchangeName || r.exchange, currency: r.currency, type: r.quoteType, finCur: r.financialCurrency || null };
      c.domestic = domesticCur(c);
      return out({ pick: pub(c), candidates: [pub(c)], exact: true, via: hit === up ? 'symbol' : 'class' });
    }
  }
  // 5. search (also without diacritics) + one bulk quote of the text on the main exchanges
  const variants = [...new Set([q, deaccent(q)])];
  let searchErr = null;
  const hits = (await Promise.all(variants.map(v => ySearchRaw(v).catch(e => { searchErr = e; return []; })))).flat();
  const rankOf = new Map();
  for (const x of hits) { const S = String(x.symbol).toUpperCase(); if (!rankOf.has(S)) rankOf.set(S, rankOf.size); }
  const ticker = /^[A-Z0-9]{1,12}$/.test(plain), digits = /^\d+$/.test(plain);
  const trial = [];
  if (light) { if (explicit) trial.push(up); }
  else if (ticker) {
    trial.push(plain, ...MAIN_SFX.map(s => `${plain}.${s}`));
    if (digits && plain.length < 4) trial.push(`${plain.padStart(4, '0')}.HK`); // Hong Kong codes have 4 digits (700 → 0700.HK)
    else if (/^[A-Z][A-Z0-9]{1,9}$/.test(plain)) trial.push(`${plain}-USD`);
  }
  if (light && searchErr && !trial.length) throw resolveDown(searchErr);
  const syms = (light ? [...new Set([...trial, ...rankOf.keys()])].filter(s => SYM_RE.test(s)).slice(0, 8) : [...new Set([...rankOf.keys(), ...trial])].filter(s => SYM_RE.test(s)));
  // the quotes are the proof (price, exchange, currency): without them nothing is verified – an error, never "not found"
  let raw;
  try { raw = syms.length ? await quoteRaw(syms) : {}; }
  catch (e) {
    if (!light || searchErr) throw resolveDown(e);
    // typing: the search hits without currency are still a useful list (not cached)
    const list = hits.filter(x => SYM_RE.test(String(x.symbol).toUpperCase())).slice(0, 8).map(x => ({ symbol: String(x.symbol).toUpperCase(), name: cleanName(x.longname) || cleanName(x.shortname) || x.symbol, exchange: x.exchDisp || x.exchange, currency: '', type: x.quoteType, domestic: false }));
    return out({ candidates: list, light: true, degraded: true });
  }
  const degraded = !!searchErr; // only the probed exchange suffixes: exact tickers count, names do not
  if (degraded && !Object.keys(raw).length) throw resolveDown(searchErr);
  const qf = firmToks(q), qk = tokKey(qf), now = Date.now();
  const cands = [];
  for (const [S, r] of Object.entries(raw)) {
    if (r.quoteType === 'OPTION') continue;
    if (r.regularMarketTime && now - r.regularMarketTime * 1000 > STALE_QUOTE && !(light && S === up)) continue;
    const sfx = sfxOf(S), base = sfx ? S.slice(0, -sfx.length - 1) : S;
    const name = qName(r), ft = firmToks(name), fk = tokKey(ft);
    const crypto = /^([A-Z0-9]+?)(\d{4,})?-[A-Z]{3}$/.exec(S);
    const exact = ticker && (base === plain || (digits && /^\d+$/.test(base) && +base === +plain) || (!digits && r.quoteType === 'CRYPTOCURRENCY' && !!crypto && crypto[1] === plain));
    // the name equals the text (Siemens = Siemens AG = Siemens Aktiengesellschaft) or starts with it (Siemens Energy)
    const exactName = !degraded && qf.length > 0 && fk === qk;
    const nameHit = !degraded && qf.length > 0 && qf.every((t, i) => ft[i] === t);
    const tier = !sfx ? (isOtc(r) ? 2 : 1) : MAIN_SET.has(sfx) ? 1 : SEC_DE.has(sfx) ? 2 : 3;
    cands.push({
      symbol: S, name, exchange: r.fullExchangeName || r.exchange, currency: r.currency, type: r.quoteType, finCur: r.financialCurrency || null, mcap: r.marketCap || null,
      sfx, otc: !sfx && isOtc(r), tier, rank: rankOf.has(S) ? rankOf.get(S) : Infinity, ord: sfx ? MAIN_SFX.indexOf(sfx) + 1 || 99 : 0, exact, exactName, nameHit: nameHit || exactName, ft, fk,
      // a coin without a market cap (memecoins like MONET-USD) is never a competitor
      junk: r.quoteType === 'CRYPTOCURRENCY' && !(r.marketCap > 0),
    });
  }
  if (light) {
    // Yahoo's order, the explicit symbol first; every firm marks its own home listing (quote currency = reporting currency)
    const list = cands.filter(c => c.rank < Infinity || c.symbol === up).sort((a, b) => (b.symbol === up) - (a.symbol === up) || byRank(a, b));
    groupFirms(list).forEach(f => preferredListing(f));
    return out({ candidates: list.slice(0, 8).map(pub), light: true, ...(searchErr ? { degraded: true } : {}) });
  }
  // market caps in USD (only to compare firms)
  const curs = [...new Set(cands.filter(c => c.mcap).map(c => unitNorm(c.currency || '')[0]).filter(Boolean))];
  const rate = {};
  await Promise.all(curs.map(async c => { try { rate[c] = (await timeoutP(fxConv(c, 'USD'), 4000, null))?.k; } catch { /* no rate */ } }));
  for (const c of cands) { const m = unitNorm(c.currency || '')[0]; c.mcapUsd = c.mcap && rate[m] ? c.mcap * rate[m] : null; }
  // firms over all listings (any venue): the home listing is chosen among all of them
  const firms = groupFirms(cands);
  const qualOf = f => f.filter(c => c.exact || c.nameHit);
  const fx = f => {
    const ql = qualOf(f);
    return { rank: ql.length ? Math.min(...ql.map(c => c.rank)) : Infinity, tier: ql.length ? Math.min(...ql.map(c => c.tier)) : Infinity, mcapUsd: Math.max(0, ...f.map(c => c.mcapUsd || 0)) || null,
      exact: f.some(c => c.exact), exactName: f.some(c => c.exactName), inSearch: f.some(c => c.rank < Infinity), equity: f.some(c => c.type === 'EQUITY'), junk: f.every(c => c.junk) };
  };
  const info = new Map(firms.map(f => [f, fx(f)]));
  const I = f => info.get(f);
  const bigger = (f, L) => (I(f).mcapUsd && I(L).mcapUsd ? I(f).mcapUsd > I(L).mcapUsd : I(f).inSearch);
  let lead = null, contenders = [];
  // 1. firms named exactly like the text (with the firms holding exactly this ticker on a main exchange): the biggest wins
  //    when it is at least 3× any other (Siemens AG ≫ Siemens Ltd; RELIANCE: Reliance Industries ≫ Reliance, Inc.), else a
  //    choice. A firm whose name only starts with the text (Siemens Energy) never wins over them.
  if (firms.some(f => I(f).exactName && !I(f).junk)) {
    const named = firms.filter(f => !I(f).junk && (I(f).exactName || (I(f).exact && I(f).tier <= 1)))
      .sort((a, b) => (I(b).mcapUsd || 0) - (I(a).mcapUsd || 0) || I(a).rank - I(b).rank);
    lead = named[0];
    const m0 = I(lead).mcapUsd || 0, dominated = f => m0 > 0 && I(f).mcapUsd > 0 && m0 >= 3 * I(f).mcapUsd;
    contenders = named.slice(1).filter(f => !dominated(f) && (I(f).mcapUsd > 0 || I(f).inSearch));
  } else {
    // 2. the ticker or a name starting with the text, on the best venue tier available
    const qual = firms.filter(f => I(f).tier < Infinity);
    const best = qual.length ? Math.min(...qual.map(f => I(f).tier)) : Infinity;
    let pool = qual.filter(f => I(f).tier === best);
    if (pool.some(f => !I(f).junk)) pool = pool.filter(f => !I(f).junk);
    if (pool.length) {
      lead = pool.slice().sort((a, b) => I(a).rank - I(b).rank)[0];
      if (I(lead).rank === Infinity) lead = pool.slice().sort((a, b) => (I(b).exact - I(a).exact) || ((I(b).mcapUsd || 0) - (I(a).mcapUsd || 0)))[0];
      // another firm with the same ticker on a main exchange competes when: the text is a number (exchange-local codes), or
      // it is bigger than the lead firm (ALV: Allianz > Autoliv), or the sizes are not comparable (ETF) and Yahoo lists it
      // without Yahoo search the probed tickers are all there is: several firms are always a choice
      contenders = pool.filter(f => f !== lead && I(f).exact && !I(f).junk && (digits || degraded || bigger(f, lead)));
    }
  }
  const others = cands.filter(c => c.tier <= 2).sort(byRank);
  if (!lead) {
    if (degraded) throw resolveDown(searchErr);
    // nothing named like the text: Yahoo's hits, one listing per firm, as a choice
    const list = groupFirms(others.filter(c => c.rank < Infinity)).slice(0, 8).map(f => preferredListing(f));
    return out({ candidates: list.map(pub) });
  }
  const involved = [lead, ...contenders];
  // company country (cached profile) only where a firm has listings in more than one country
  const countries = await Promise.all(involved.map(f => {
    if (new Set(f.map(c => c.sfx)).size < 2) return null;
    const probe = [...f].sort(byTier).find(c => c.type === 'EQUITY') || [...f].sort(byTier)[0];
    return timeoutP(getProfile(probe.symbol), 4000, {}).then(p => (p && p.country) || null, () => null);
  }));
  // every other firm in the list marks its own home listing too (without a profile)
  firms.forEach(f => { if (!involved.includes(f)) preferredListing(f); });
  const prefs = involved.map((f, i) => preferredListing(f, countries[i]));
  const exact = involved.some(f => I(f).exact);
  const rest = others.filter(c => !prefs.includes(c)).slice(0, 12);
  const flags = degraded ? { degraded: true } : {};
  if (!contenders.length) {
    const pick = prefs[0];
    return out({ pick: pub(pick), candidates: [pick, ...rest].slice(0, 12).map(pub), exact, country: countries[0] || null, ...flags });
  }
  // a choice: equities by size, then the rest (ETF, funds) by Yahoo's order
  const order = prefs.map((c, i) => ({ c, f: I(involved[i]) }))
    .sort((a, b) => (b.f.equity && b.f.mcapUsd ? 1 : 0) - (a.f.equity && a.f.mcapUsd ? 1 : 0) || (b.f.mcapUsd || 0) - (a.f.mcapUsd || 0) || a.f.rank - b.f.rank)
    .map(x => x.c);
  return out({ choice: order.map(pub), candidates: [...order, ...rest].slice(0, 12).map(pub), exact, ...flags });
}
// results while Yahoo search failed (degraded) are kept only briefly; light (typing) lists for 10 minutes
function resolveQuery(raw, { light = false } = {}) {
  const q = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!q) return Promise.resolve({ q, pick: null, choice: null, candidates: [], exact: false });
  return cached((light ? 'resolveL:' : 'resolve:') + deaccent(q).toUpperCase(), v => (v.degraded ? 15e3 : light ? 10 * 60e3 : v.pick || v.choice ? 30 * 60e3 : 5 * 60e3), () => resolveRun(q, { light }), 30 * 60e3);
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
  // capex fallbacks (some exchanges, e.g. Prague, lack CapitalExpenditure)
  CapitalExpenditureReported: 'capexRep', PurchaseOfPPE: 'ppeBuy', NetPPEPurchaseAndSale: 'ppeNet',
  // FCF for shareholders: interest paid shown in financing (IFRS only) is deducted, and so are lease repayments. Yahoo has no line for lease
  // repayments, the current lease liability (principal due within a year) stands in for them. Where interest paid appears at all tells the
  // presentation: IFRS shows it as a line of the cash-flow statement (CFO or CFF), US GAAP only as supplemental data (FA.base decides)
  InterestPaidCFF: 'intPaidCff', InterestPaidCFO: 'intPaidCfo', InterestPaidSupplementalData: 'intPaidSup', CurrentCapitalLeaseObligation: 'leaseCur',
  // EPS check (net income attributable to common shareholders) and one-off items (Yahoo's normalized income)
  NetIncomeCommonStockholders: 'niCommon', NormalizedIncome: 'niNorm',
};
// quarterly items: balance sheet (debt, cash and equity must come from the same date: D/E, EV, ROE), the current lease liability for the TTM
// period and quarterly EPS (sum of four quarters = check of the TTM EPS)
const TS_QUARTERLY = { StockholdersEquity: 'equity', TotalDebt: 'debt', CashAndCashEquivalents: 'cash', CashCashEquivalentsAndShortTermInvestments: 'cashSti', CurrentCapitalLeaseObligation: 'leaseCur', DilutedEPS: 'eps' };
// a TTM ("trailing") value much older than the newest statements is not used (KOMB.PR reported dividends paid in 2019 as TTM)
const TTM_MAX_AGE = 450 * 864e5; // ~15 months
// long-term government bond yield per main currency (risk-free rate for discounting), FRED / OECD monthly series
const RF_SERIES = {
  USD: 'DGS10', EUR: 'IRLTLT01DEM156N', CZK: 'IRLTLT01CZM156N', GBP: 'IRLTLT01GBM156N', JPY: 'IRLTLT01JPM156N', CHF: 'IRLTLT01CHM156N', PLN: 'IRLTLT01PLM156N',
  DKK: 'IRLTLT01DKM156N', SEK: 'IRLTLT01SEM156N', NOK: 'IRLTLT01NOM156N', HUF: 'IRLTLT01HUM156N', ZAR: 'IRLTLT01ZAM156N', ILS: 'IRLTLT01ILM156N',
  INR: 'INDIRLTLT01STM', AUD: 'IRLTLT01AUM156N', CAD: 'IRLTLT01CAM156N', NZD: 'IRLTLT01NZM156N', KRW: 'IRLTLT01KRM156N', MXN: 'IRLTLT01MXM156N', CLP: 'IRLTLT01CLM156N',
  COP: 'COLIRLTLT01STM',
};
const RF_NAME = {
  DGS10: 'US 10Y', IRLTLT01DEM156N: 'DE 10Y (Bund)', IRLTLT01CZM156N: 'CZ 10Y', IRLTLT01GBM156N: 'UK 10Y', IRLTLT01JPM156N: 'JP 10Y', IRLTLT01CHM156N: 'CH 10Y', IRLTLT01PLM156N: 'PL 10Y',
  IRLTLT01DKM156N: 'DK 10Y', IRLTLT01SEM156N: 'SE 10Y', IRLTLT01NOM156N: 'NO 10Y', IRLTLT01HUM156N: 'HU 10Y', IRLTLT01ZAM156N: 'ZA 10Y', IRLTLT01ILM156N: 'IL 10Y',
  INDIRLTLT01STM: 'IN 10Y', IRLTLT01AUM156N: 'AU 10Y', IRLTLT01CAM156N: 'CA 10Y', IRLTLT01NZM156N: 'NZ 10Y', IRLTLT01KRM156N: 'KR 10Y', IRLTLT01MXM156N: 'MX 10Y', IRLTLT01CLM156N: 'CL 10Y',
  COLIRLTLT01STM: 'CO 10Y',
};
// currencies without a long-term government yield on FRED (checked 11/2026 – OECD has no 10Y series for China, Taiwan, Hong Kong or Brazil,
// the IMF only a Brazilian treasury-bill yield INTGSTBRM193N, a short-term rate): US 10Y + country risk premium, the reason is shown
const RF_NONE = {
  CNY: 'FRED nemá výnos čínských státních dluhopisů', TWD: 'FRED nemá výnos tchajwanských státních dluhopisů',
  BRL: 'FRED má pro Brazílii jen výnos krátkodobých pokladničních poukázek (IMF), ne 10letých dluhopisů', HKD: 'HKD je pevně navázaný na USD, používá se US 10Y',
};
const RF_MAX_AGE = 183 * 864e5; // a local series older than ~6 months is not used (US 10Y instead)
const RF_FIXED = 4.2; // only when FRED is unreachable
const yraw = v => (v == null ? null : typeof v === 'object' ? (v.raw ?? null) : v);
const unitNorm = c => (c === 'GBp' || c === 'GBX' ? ['GBP', 0.01] : c === 'ZAc' ? ['ZAR', 0.01] : c === 'ILA' ? ['ILS', 0.01] : c === 'USX' ? ['USD', 0.01] : [c, 1]);

// Last good rate of every pair, persisted as { "USD>CZK": { k, t } } with t = time of the data (ČNB fixing, quote),
// not of its use. Used (flagged stale) when all FX sources fail – never a silent 1 : 1.
const FX_LAST_FILE = path.join(DATA_DIR, 'fx-last.json');
const FX_PAIR_RE = /^[A-Z]{3}>[A-Z]{3}$/;
let fxLast = {}, fxLastTimer = null;
// a valid entry has a positive rate; a missing or invalid t means "stale, date unknown"
const fxEntry = e => (e && typeof e === 'object' && Number.isFinite(e.k) && e.k > 0 ? { k: e.k, t: Number.isFinite(e.t) && e.t > 0 ? e.t : null } : null);
function loadFxLast() {
  let raw = null, bad = false;
  try { raw = JSON.parse(fs.readFileSync(FX_LAST_FILE, 'utf8')); } catch (e) { bad = e.code !== 'ENOENT'; }
  fxLast = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, e] of Object.entries(raw)) { const v = FX_PAIR_RE.test(key) && fxEntry(e); if (v) fxLast[key] = v; else bad = true; }
  } else if (raw != null) bad = true;
  // self-repair: unreadable content or invalid entries are dropped and the file rewritten
  if (bad) { log('fx-last.json: invalid content ignored, the file will be rewritten'); scheduleFxFlush(2000); }
}
function flushFxLast() { clearTimeout(fxLastTimer); fxLastTimer = null; writeJSONAtomic(FX_LAST_FILE, fxLast, { track: false }); }
function scheduleFxFlush(ms) { if (!fxLastTimer) fxLastTimer = setTimeout(flushFxLast, ms); }
function rememberFx(f, t, k, at) {
  if (!(k > 0) || !Number.isFinite(k)) return;
  const key = `${f}>${t}`, prev = fxLast[key], when = Number.isFinite(at) && at > 0 ? at : Date.now();
  if (prev && prev.t && prev.t > when) return; // never replace newer data with older
  fxLast[key] = { k, t: when };
  if (!prev) { clearTimeout(fxLastTimer); fxLastTimer = null; }
  scheduleFxFlush(prev ? 10 * 60e3 : 2000);
}
const fxMinT = (a, b) => (a == null || b == null ? null : Math.min(a, b)); // unknown when either side is unknown
const fxNewer = (a, b) => (!a ? b : !b ? a : (b.t ?? 0) > (a.t ?? 0) ? b : a);
// conversion factor from → to: { k, stale, t } with t = time of the data (null = unknown); a stale rate comes from an old ČNB
// fixing, a stale quote or fx-last.json; throws when no rate exists at all
async function fxConv(from, to) {
  if (!from || !to || from === to) return { k: 1, stale: false, t: Date.now() };
  const [f, fm] = unitNorm(from), [t, tm] = unitNorm(to);
  if (f === t) return { k: fm / tm, stale: false, t: Date.now() };
  const unit = x => ({ k: (x.k * fm) / tm, stale: x.stale, t: x.t });
  const fx = await cached('fx', 60e3, getFx).catch(() => null);
  const r = (fx && fx.rates) || {}, st = (fx && fx.stale) || {}, at = (fx && fx.asOf) || {};
  let best = null;
  if (r[f] > 0 && r[t] > 0) {
    best = { k: r[f] / r[t], stale: f in st || t in st, t: fxMinT(at[f], at[t]) };
    if (!best.stale) { rememberFx(f, t, best.k, best.t); return unit(best); }
  }
  const s = `${f}${t}=X`, q = (await getQuotes([s]).catch(() => ({})))[s];
  if (q && q.price > 0) {
    const c = { k: q.price, stale: !!q.stale, t: q.time || null };
    if (!c.stale) { rememberFx(f, t, c.k, c.t); return unit(c); }
    best = fxNewer(best, c);
  }
  const d = fxLast[`${f}>${t}`], inv = fxLast[`${t}>${f}`];
  if (d) best = fxNewer(best, { k: d.k, stale: true, t: d.t });
  if (inv) best = fxNewer(best, { k: 1 / inv.k, stale: true, t: inv.t });
  if (best) return unit(best);
  throw Object.assign(new Error(`kurz ${from}→${to} není k dispozici (zdroje kurzů nedostupné, uložený kurz neexistuje)`), { fxMissing: true });
}

// FCF needs capex: Yahoo sometimes reports FreeCashFlow = OperatingCashFlow while CapitalExpenditure is missing (CEZ.PR)
function fixFcf(x) {
  if (x.capex == null) {
    const alt = [['capexRep', 'CapitalExpenditureReported'], ['ppeBuy', 'PurchaseOfPPE'], ['ppeNet', 'NetPPEPurchaseAndSale']].find(([k]) => x[k] != null && x[k] <= 0);
    if (alt) { x.capex = x[alt[0]]; x.capexSrc = alt[1]; }
  }
  if (x.capex != null && x.ocf != null) { if (x.fcf == null || (x.fcf === x.ocf && x.capex !== 0)) x.fcf = x.ocf + x.capex; }
  else if (x.fcf != null && x.ocf != null && x.fcf === x.ocf) { x.fcf = null; x.fcfNoCapex = true; }
  delete x.capexRep; delete x.ppeBuy; delete x.ppeNet;
  return x;
}

// peers for the relative valuation: same sector, preferably the same industry, at most 5 (profiles cached 24 h).
// Profiles load in parallel, each waited for at most PEER_WAIT (a slow one finishes in the background and is cached);
// a failure is reported as peersErr – the caller then caches the fundamentals only briefly.
const PEER_WAIT = 3000;
const within = (p, ms) => new Promise((ok, fail) => { const t = setTimeout(() => fail(new Error('timeout')), ms); p.then(v => { clearTimeout(t); ok(v); }, e => { clearTimeout(t); fail(e); }); });
// one firm under several listings (GDR/ADR, other share class, second exchange): the same normalised name or the same web domain.
// "SAMSUNG ELECTRONICS CO LTD (ATT" (GDR, London) = "Samsung Electronics Co., Ltd."; "SK hynix" = "SK hynix Inc."
const FIRM_STOP = /\b(co|corp|corporation|company|companies|ltd|limited|inc|incorporated|plc|ag|se|sa|nv|spa|ab|asa|oyj|as|kgaa|bhd|tbk|holdings?|group|gdr|adr|ads|sponsored|unsponsored|reg|registered|ord|ordinary|shares?|stock|class|pref|preferred|the|and)\b/g;
const firmKey = n => {
  const s = String(n || '').toLowerCase().replace(/\s*\([^)]*$/, '') // truncated note at the end: "(ATT", "(REPR"
    .replace(/\((?:[^)]*\b(?:gdr|adr|ads|repr|reg s|144a|att)\b[^)]*)\)/g, ' ')
    .replace(/\$?\d+(?:[.,]\d+)?/g, ' ').replace(/[.,'’&/-]/g, ' ').replace(FIRM_STOP, ' ').replace(/\b[a-z]\b/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length >= 3 ? s : null;
};
const siteKey = w => { if (!w) return null; try { return new URL(/^https?:/i.test(w) ? w : 'http://' + w).hostname.toLowerCase().replace(/^www\d?\./, '') || null; } catch { return null; } };
async function peerFilter(sector, industry, list, self = {}) {
  if (!list.length) return { peers: [], peerInfo: [], peersErr: null };
  const res = await Promise.all(list.map(s => within(profileOf(s), PEER_WAIT).then(p => ({ p }), e => ({ err: e.message || 'chyba' }))));
  const info = list.map((s, i) => { const p = res[i].p || {}; return { symbol: s, name: p.name || null, sector: p.sector || null, industry: p.industry || null, failed: !!res[i].err, site: siteKey(p.website) }; });
  // other listings of the analysed firm (same: 'self') and the second listing of a peer (same: symbol of the first) are not compared
  const selfName = firmKey(self.name), selfSite = siteKey(self.website), seen = new Map();
  for (const p of info) {
    if (p.failed) continue;
    const nk = firmKey(p.name), sk = p.site;
    if ((nk && nk === selfName) || (sk && sk === selfSite)) { p.same = 'self'; continue; }
    const first = (nk && seen.get('n:' + nk)) || (sk && seen.get('s:' + sk));
    if (first) { p.same = first; continue; }
    if (nk) seen.set('n:' + nk, p.symbol);
    if (sk) seen.set('s:' + sk, p.symbol);
  }
  const ok = info.filter(p => !p.same);
  const sameInd = ok.filter(p => sector && industry && p.sector === sector && p.industry === industry);
  const sameSec = ok.filter(p => sector && p.sector === sector && !sameInd.includes(p));
  const use = (sameInd.length >= 2 ? sameInd : [...sameInd, ...sameSec]).slice(0, 5);
  const failed = info.filter(p => p.failed).length;
  return {
    peers: use.map(p => p.symbol),
    peerInfo: info.map(({ site, ...p }) => ({ ...p, same: p.same || null, used: use.some(u => u.symbol === p.symbol), match: sameInd.some(u => u.symbol === p.symbol) ? 'industry' : sameSec.some(u => u.symbol === p.symbol) ? 'sector' : null })),
    peersErr: failed ? (failed === list.length ? 'profily konkurence se nenačetly' : `profil ${failed} z ${list.length} firem se nenačetl`) : null,
  };
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

// dividends paid per share (ex-dates) over 5 years from the dividend events of the daily chart (getChart(…, true)), in the quote unit;
// checks Yahoo's annualised dividendRate. null = unknown (chart missing or in another currency), [] = no payment in 5 years
function divHistory(ch, currency) {
  if (!ch || !ch.divEvents || (ch.currency && currency && ch.currency !== currency)) return null;
  return Object.values(ch.divEvents).map(x => ({ t: x.date * 1000, a: x.amount })).filter(x => x.t > 0 && x.a > 0).sort((a, b) => a.t - b.t);
}

function getFundamentals(sym) {
  // a degraded result (FX rate missing or stale, peer profiles or the chart with dividends not loaded) is cached only briefly;
  // 'fund2:' – the data shape changed in 1.5
  return cached('fund2:' + sym, v => (v.fxErr || v.fxStale || v.peersErr || v.divsErr ? 2 * 60e3 : 6 * 3600e3), async () => {
    const mods = 'assetProfile,financialData,defaultKeyStatistics,summaryDetail,price,earningsTrend,recommendationTrend,calendarEvents,earningsHistory';
    const p2 = Math.floor(Date.now() / 1000), p1 = p2 - 7 * 365 * 86400;
    const types = [...Object.keys(TS_KEY).flatMap(k => ['annual' + k, 'trailing' + k]), ...Object.keys(TS_QUARTERLY).map(k => 'quarterly' + k)].join(',');
    // the daily chart (technicals) brings the dividend events along – no separate request that could fail or delay on its own
    let chErr = null;
    const [qs, ts, ch, pe] = await Promise.all([
      yahooJSON(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=${mods}`),
      yahooJSON(`https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(sym)}?symbol=${encodeURIComponent(sym)}&type=${types}&period1=${p1}&period2=${p2}`).catch(() => null),
      getChart(sym, '5y', '1d', true).catch(e => { chErr = e.message || 'chyba'; return null; }),
      yahooJSON(`https://query2.finance.yahoo.com/v6/finance/recommendationsbysymbol/${encodeURIComponent(sym)}`).catch(() => null),
    ]);
    const r = qs && qs.quoteSummary && qs.quoteSummary.result && qs.quoteSummary.result[0];
    if (!r) throw Object.assign(new Error((qs && qs.quoteSummary && qs.quoteSummary.error && qs.quoteSummary.error.description) || 'fundamentální data nejsou k dispozici'), { status: 404 });
    const fd = r.financialData || {}, ks = r.defaultKeyStatistics || {}, sd = r.summaryDetail || {}, pr = r.price || {}, ap = r.assetProfile || {};
    // statements; curN counts the currency of the items (Yahoo's financialCurrency can be wrong: VALE3.SA reports in USD, Yahoo says BRL)
    const annualMap = {}, quarterMap = {}, ttm = {}, ttmPrev = {}, ttmAt = {}, fyAt = {}, curN = {};
    for (const x of (ts && ts.timeseries && ts.timeseries.result) || []) {
      const typ = x.meta && x.meta.type && x.meta.type[0];
      const m = typ && typ.match(/^(annual|trailing|quarterly)(.+)$/);
      const key = m && (m[1] === 'quarterly' ? TS_QUARTERLY : TS_KEY)[m[2]];
      if (!key) continue;
      const arr = (x[typ] || []).filter(v => v && v.reportedValue && v.reportedValue.raw != null).sort((a, b) => a.asOfDate.localeCompare(b.asOfDate));
      if (!arr.length) continue;
      for (const v of arr) if (v.currencyCode) curN[v.currencyCode] = (curN[v.currencyCode] || 0) + 1;
      if (m[1] === 'annual') { for (const v of arr) (annualMap[v.asOfDate] = annualMap[v.asOfDate] || { date: v.asOfDate })[key] = v.reportedValue.raw; fyAt[key] = arr[arr.length - 1].asOfDate; }
      else if (m[1] === 'quarterly') { for (const v of arr) (quarterMap[v.asOfDate] = quarterMap[v.asOfDate] || { date: v.asOfDate })[key] = v.reportedValue.raw; }
      else {
        const lastV = arr[arr.length - 1];
        ttm[key] = lastV.reportedValue.raw; ttmAt[key] = lastV.asOfDate;
        const cutoff = isoDate(Date.parse(lastV.asOfDate) - 300 * 864e5);
        const prev = arr.filter(v => v.asOfDate <= cutoff).pop();
        if (prev) ttmPrev[key] = prev.reportedValue.raw;
      }
    }
    // a TTM value ~15 months older than the newest statements, or older than the last fiscal year of the same item, is not used
    // (the last fiscal year takes its place in FA.base); the client lists what was dropped
    const newest = [...Object.keys(annualMap), ...Object.keys(quarterMap), ...Object.values(ttmAt)].sort().pop();
    const ttmStale = [];
    for (const [k, at] of Object.entries(ttmAt)) {
      const old = newest && Date.parse(newest) - Date.parse(at) > TTM_MAX_AGE, behind = fyAt[k] && fyAt[k] > at;
      if (old || behind) { ttmStale.push({ key: k, date: at, fy: behind ? fyAt[k] : null }); delete ttm[k]; delete ttmPrev[k]; delete ttmAt[k]; }
    }
    ttm.date = Object.values(ttmAt).sort().pop();
    const annual = Object.values(annualMap).sort((a, b) => a.date.localeCompare(b.date)).filter(a => a.revenue != null || a.netIncome != null || a.assets != null).map(fixFcf);
    fixFcf(ttm);
    const quarterly = Object.values(quarterMap).sort((a, b) => a.date.localeCompare(b.date)).slice(-8);
    const price = yraw(fd.currentPrice) ?? yraw(pr.regularMarketPrice);
    const currency = pr.currency || sd.currency;
    // statement currency: the currency of the items wins over financialCurrency (both shown when they differ)
    const itemCur = Object.entries(curN).sort((a, b) => b[1] - a[1]).map(e => e[0])[0] || null;
    const finCur = itemCur || fd.financialCurrency || currency;
    const finCurYahoo = fd.financialCurrency && fd.financialCurrency !== finCur ? fd.financialCurrency : null;
    // Yahoo quotes some exchanges in a sub-unit (GBp, ZAc, ILA) but market cap, EPS, dividend and statements in the main currency:
    // valuation runs in the main currency, fx converts the statements (finCur) into it
    const [mainCur, unit] = unitNorm(currency);
    let fx = null, fxErr = null, fxStale = null, fxAsOf = null; // fxStale: data time of a stale rate, true when unknown
    try { const c = await fxConv(finCur, mainCur); fx = c.k; fxAsOf = c.t ?? null; if (c.stale) fxStale = c.t ?? true; } catch (e) { fxErr = e.message; }
    // risk-free rate: the local long-term yield when FRED has a fresh one (≤ ~6 months), else US 10Y; US 10Y and AAA also give the
    // corporate spread of Graham's formula (local AAA = local rate + US AAA − US 10Y)
    const rfId = RF_SERIES[mainCur] || null, from = isoDate(Date.now() - 500 * 864e5);
    const [rfS, usS, aaaS, peerSel] = await Promise.all([
      rfId && rfId !== 'DGS10' ? fred(rfId, from).catch(() => null) : null, fred('DGS10', from).catch(() => null), fred('DAAA', isoDate(Date.now() - 120 * 864e5)).catch(() => null),
      peerFilter(ap.sector, ap.industry, (((pe && pe.finance && pe.finance.result && pe.finance.result[0] && pe.finance.result[0].recommendedSymbols) || []).map(x => x.symbol)).filter(s => s !== sym).slice(0, 8),
        { name: pr.longName || pr.shortName, website: ap.website }),
    ]);
    const lastObs = s => (s && s.length ? s[s.length - 1] : null);
    const us = lastObs(usS), loc = rfId === 'DGS10' ? us : lastObs(rfS);
    const locOld = !!(loc && rfId !== 'DGS10' && Date.now() - Date.parse(loc[0]) > RF_MAX_AGE), useLoc = !!(loc && !locOld);
    const rfObs = useLoc ? loc : us, rf = rfObs ? rfObs[1] : RF_FIXED;
    const aaaObs = lastObs(aaaS);
    const trend = ((r.earningsTrend && r.earningsTrend.trend) || []).map(x => ({
      period: x.period, end: x.endDate, growth: yraw(x.growth),
      eps: yraw(x.earningsEstimate && x.earningsEstimate.avg), epsLow: yraw(x.earningsEstimate && x.earningsEstimate.low), epsHigh: yraw(x.earningsEstimate && x.earningsEstimate.high),
      epsYearAgo: yraw(x.earningsEstimate && x.earningsEstimate.yearAgoEps), epsAnalysts: yraw(x.earningsEstimate && x.earningsEstimate.numberOfAnalysts),
      cur: (x.earningsEstimate && x.earningsEstimate.earningsCurrency) || null,
      rev: yraw(x.revenueEstimate && x.revenueEstimate.avg), revGrowth: yraw(x.revenueEstimate && x.revenueEstimate.growth),
      // revenue estimates are a component of the default growth (FA.growth): their base, number of analysts and currency are checked
      revYearAgo: yraw(x.revenueEstimate && x.revenueEstimate.yearAgoRevenue), revAnalysts: yraw(x.revenueEstimate && x.revenueEstimate.numberOfAnalysts),
      revCur: (x.revenueEstimate && x.revenueEstimate.revenueCurrency) || null,
    }));
    const cal = r.calendarEvents || {};
    const out = {
      symbol: pr.symbol || sym, name: pr.longName || pr.shortName || sym, longName: pr.longName, type: pr.quoteType, exchange: pr.exchangeName, exchangeName: pr.exchange,
      currency, mainCur, unit, finCur, finCurYahoo, fx, fxErr, fxStale, fxAsOf, price, change: yraw(pr.regularMarketChange), changePct: yraw(pr.regularMarketChangePercent) != null ? yraw(pr.regularMarketChangePercent) * 100 : null,
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
      annual, ttm, ttmPrev, ttmAt, ttmStale, quarterly,
      // divsErr: the chart with the dividend events did not load – the dividend check falls back to the statements, cached briefly
      divs: divHistory(ch, currency), divsErr: ch ? null : `graf s dividendami se nenačetl (${String(chErr || 'chyba').slice(0, 80)})`,
      // fallback = US 10Y used instead of a local yield: none = FRED has no series for the currency (why), old = the local series is
      // older than ~6 months (its last observation), err = the local series did not load; fixed = FRED unreachable
      rf: {
        rate: rf, series: rfObs ? (useLoc ? rfId : 'DGS10') : null, name: rfObs ? (useLoc ? RF_NAME[rfId] || rfId : 'US 10Y') : 'pevná sazba', date: rfObs ? rfObs[0] : null, currency: mainCur,
        fallback: mainCur !== 'USD' && !useLoc, fixed: !rfObs, none: rfId ? null : RF_NONE[mainCur] || 'FRED pro tuto měnu nemá řadu dlouhodobých výnosů',
        old: locOld ? { series: rfId, name: RF_NAME[rfId] || rfId, date: loc[0], rate: loc[1] } : null, err: !!(rfId && rfId !== 'DGS10' && !rfS),
      },
      us10: us ? { rate: us[1], date: us[0] } : null,
      aaa: aaaObs ? aaaObs[1] : null, aaaDate: aaaObs ? aaaObs[0] : null,
      tech: ch && ch.c.length ? technicals(ch, rf) : null,
      peers: peerSel.peers, peerInfo: peerSel.peerInfo, peersErr: peerSel.peersErr,
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

// Rates vs CZK with the time of their data (asOf) and stale flags. Per currency: a fresh live quote, else a fresh ČNB fixing,
// else the newest stale one (old ČNB fixing from the stale-on-error cache, quote that failed to refresh, fx-last.json).
const CNB_STALE = 4 * 864e5; // a ČNB fixing older than 4 days (weekends, holidays) is stale
async function getFx() {
  const cnb = await getCnbFx().catch(e => { mark('cnb', false, e.message); return null; });
  const cnbT = cnb && cnb.date ? Date.parse(cnb.date + 'T13:30:00Z') : null; // the fixing is published at 14:30 Prague time
  const cnbStale = !cnbT || Date.now() - cnbT > CNB_STALE;
  const liveMap = { 'CZK=X': 'USD', 'EURCZK=X': 'EUR', 'GBPCZK=X': 'GBP', 'CHFCZK=X': 'CHF', 'JPYCZK=X': 'JPY', 'PLNCZK=X': 'PLN' };
  const live = await getQuotes(Object.keys(liveMap)).catch(() => ({}));
  const cand = {};
  const add = (c, k, t, stale, src) => { if (k > 0 && Number.isFinite(k)) (cand[c] = cand[c] || []).push({ k, t: t || null, stale, src }); };
  if (cnb) for (const [c, k] of Object.entries(cnb.rates)) if (c !== 'CZK') add(c, k, cnbT, cnbStale, 'cnb');
  for (const [s, c] of Object.entries(liveMap)) { const q = live[s]; if (q) add(c, q.price, q.time, !!q.stale, 'live'); }
  for (const [key, e] of Object.entries(fxLast)) { const [a, b] = key.split('>'); if (b === 'CZK') add(a, e.k, e.t, true, 'saved'); else if (a === 'CZK') add(b, 1 / e.k, e.t, true, 'saved'); }
  const rank = x => (x.stale ? 0 : x.src === 'live' ? 2 : 1);
  const rates = { CZK: 1 }, asOf = { CZK: Date.now() }, stale = {}, liveList = [];
  for (const [c, list] of Object.entries(cand)) {
    const b = list.reduce((x, y) => (rank(y) > rank(x) || (rank(y) === rank(x) && (y.t ?? 0) > (x.t ?? 0)) ? y : x));
    rates[c] = b.k; asOf[c] = b.t;
    if (b.stale) stale[c] = b.t; else if (b.src === 'live') liveList.push(c);
  }
  for (const [sub, main] of [['GBp', 'GBP'], ['GBX', 'GBP'], ['USX', 'USD'], ['ZAc', 'ZAR'], ['ILA', 'ILS']]) {
    if (!rates[main]) continue;
    rates[sub] = rates[main] / 100; asOf[sub] = asOf[main];
    if (main in stale) stale[sub] = stale[main];
  }
  return { base: 'CZK', date: cnb ? cnb.date : null, cnbStale: !!cnb && cnbStale, rates, live: liveList, names: (cnb && cnb.names) || { CZK: 'Česko – koruna' }, asOf, stale };
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
  writeJSONAtomic(ARCHIVE_FILE, archive, { track: false }); // a cache of external data, not user state
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
    link = link.trim();
    if (!/^https?:\/\/[^\s"'<>]+$/i.test(link)) link = ''; // only http(s) links (Atom href may carry javascript: or data:)
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
// Yahoo's exchange names in a readable form (NYSEArca → NYSE Arca, NasdaqGS → Nasdaq)
const EXCH_NAME = { NYSEArca: 'NYSE Arca', NasdaqGS: 'Nasdaq', NasdaqGM: 'Nasdaq', NasdaqCM: 'Nasdaq', NYQ: 'NYSE', PCX: 'NYSE Arca', NMS: 'Nasdaq', CCC: 'CoinMarketCap', CCY: 'Forex' };
const exchName = e => EXCH_NAME[e] || String(e || '');
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
      const sym = String(a.symbol).toUpperCase(), q = quotes[sym];
      // a symbol Yahoo does not know never fires; the flag tells the UI (cleared as soon as a quote exists)
      if (!q || q.price == null) { if (!q && badSym.has(sym) && !a.noQuote) { a.noQuote = Date.now(); changed = true; } continue; }
      if (a.noQuote) { delete a.noQuote; changed = true; }
      if (q.stale) continue;
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
      // the name and exchange of what is really watched: an old alert on "BTC" says Grayscale Bitcoin Mini Trust, not bitcoin
      const name = cleanName(q.name || a.name || ''), exch = exchName(q.exchange || a.exchange || '');
      const label = `${a.symbol}${name && name.toUpperCase() !== sym ? ` (${[name, exch].filter(Boolean).join(', ')})` : exch ? ` (${exch})` : ''}`;
      const msg = `${label} = ${fmtNum(q.price)} ${q.currency || ''} (${q.changePct >= 0 ? '+' : ''}${(q.changePct || 0).toFixed(2)} %) – ${desc}${a.note ? ' · ' + a.note : ''}`;
      pushEvent({ type: 'alert', title: `🔔 Alert ${a.symbol}`, message: msg, alertId: a.id, symbol: a.symbol, price: q.price });
      state.alerts.history = [{ id: hash(a.id + a.triggeredAt), alertId: a.id, symbol: a.symbol, ts: a.triggeredAt, price: q.price, message: msg }, ...(state.alerts.history || [])].slice(0, 200);
      notifyAll(`🔔 FinTerm alert: ${label}`, msg, { priority: 'high', tags: 'bell', data: { symbol: a.symbol, name: name || null, exchange: exch || null, currency: q.currency || null, price: q.price } }).catch(() => {});
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

// CoinGecko ids with a regular Yahoo quote (checked 11. 11. 2026). Every other id (uniswap, matic-network, sui, pepe…:
// Yahoo has them only under numbered symbols like UNI7083-USD) is priced through CoinGecko as CG:<id>.
const CG_MAP = { bitcoin: 'BTC-USD', ethereum: 'ETH-USD', solana: 'SOL-USD', ripple: 'XRP-USD', cardano: 'ADA-USD', dogecoin: 'DOGE-USD', binancecoin: 'BNB-USD', tron: 'TRX-USD', chainlink: 'LINK-USD', 'avalanche-2': 'AVAX-USD', polkadot: 'DOT-USD', litecoin: 'LTC-USD', 'bitcoin-cash': 'BCH-USD', monero: 'XMR-USD', stellar: 'XLM-USD', 'shiba-inu': 'SHIB-USD', cosmos: 'ATOM-USD', 'ethereum-classic': 'ETC-USD' };
const CG_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
// EOD Historical Data exchange codes → Yahoo suffixes ('' = USA); CC = crypto, FOREX, INDX
const EOD_SFX = {
  US: '', NYSE: '', NASDAQ: '', XETRA: 'DE', F: 'F', BE: 'BE', DU: 'DU', HM: 'HM', HA: 'HA', MU: 'MU', STU: 'SG', LSE: 'L', IL: 'IL', PA: 'PA', AS: 'AS', BR: 'BR', LS: 'LS', IR: 'IR',
  MI: 'MI', MC: 'MC', SW: 'SW', VX: 'SW', VI: 'VI', PR: 'PR', WAR: 'WA', BUD: 'BD', ST: 'ST', CO: 'CO', HE: 'HE', OL: 'OL', IC: 'IC', TO: 'TO', V: 'V', NEO: 'NE', AU: 'AX',
  HK: 'HK', TSE: 'T', KO: 'KS', KQ: 'KQ', TW: 'TW', TWO: 'TWO', SHG: 'SS', SHE: 'SZ', NSE: 'NS', BSE: 'BO', SA: 'SA', MX: 'MX', JSE: 'JO', TA: 'TA', SG: 'SI', JK: 'JK', KLSE: 'KL', BK: 'BK', IS: 'IS', AT: 'AT',
};
const ISO_CUR = new Set(['USD', 'EUR', 'CZK', 'GBP', 'CHF', 'JPY', 'PLN', 'HUF', 'SEK', 'NOK', 'DKK', 'ISK', 'CAD', 'AUD', 'NZD', 'HKD', 'SGD', 'CNY', 'CNH', 'INR', 'KRW', 'TWD', 'BRL', 'MXN', 'ZAR', 'ILS', 'TRY', 'THB', 'IDR', 'MYR', 'PHP', 'RON', 'BGN', 'AED', 'SAR', 'RUB']);
// Ghostfolio asset classes of manual assets → the classes used by the portfolio
const GF_TYPE = { ETF: 'ETF', MUTUALFUND: 'MUTUALFUND', STOCK: 'EQUITY', CRYPTOCURRENCY: 'CRYPTOCURRENCY', PRECIOUS_METAL: 'FUTURE', COMMODITY: 'FUTURE', BOND: 'BOND' };
// Ghostfolio symbol → { y, alt } (alt = other spellings, decided by a Yahoo quote)
function gfSymbol(ds, sym, prof) {
  const s = String(sym || '').trim();
  if (!s) return { y: null };
  if (ds === 'COINGECKO') { const id = s.toLowerCase(); return { y: CG_MAP[id] || (CG_ID.test(id) ? 'CG:' + id : null), cg: !CG_MAP[id] }; }
  if (ds === 'MANUAL') return { y: 'MANUAL:' + s, manual: true };
  const u = s.toUpperCase();
  if (ds === 'EOD_HISTORICAL_DATA' || ds === 'EODHD') {
    const m = /^(.+)\.([A-Z]+)$/.exec(u);
    if (m && m[2] === 'CC') return { y: m[1] };                        // BTC-USD.CC
    if (m && m[2] === 'FOREX') return { y: m[1].replace(/=X$/, '') + '=X' }; // EURUSD.FOREX
    if (m && m[2] === 'INDX') return { y: '^' + m[1] };                 // GSPC.INDX
    if (m && m[2] in EOD_SFX) return { y: EOD_SFX[m[2]] ? `${m[1]}.${EOD_SFX[m[2]]}` : m[1] };
    return { y: u };
  }
  // YAHOO, FINANCIAL_MODELING_PREP and others: Ghostfolio stores crypto as BTCUSD (convertFromYahooFinanceSymbol)
  // and currency pairs without =X
  const sub = String((prof && prof.assetSubClass) || '').toUpperCase();
  if (/^[A-Z0-9]{2,15}USD$/.test(u) && sub === 'CRYPTOCURRENCY') return { y: u.slice(0, -3) + '-USD' };
  if (/^[A-Z]{6}$/.test(u) && ISO_CUR.has(u.slice(0, 3)) && ISO_CUR.has(u.slice(3))) return { y: u + '=X' };
  if (/^[A-Z0-9]{2,15}USD$/.test(u) && !sub) return { y: u, alt: [u.slice(0, -3) + '-USD'] };
  return { y: u };
}
function gfPrices(md) {
  const by = new Map();
  for (const p of Array.isArray(md) ? md : []) {
    const ts = Date.parse(p && p.date), v = +(p && (p.marketPrice ?? p.price));
    if (Number.isFinite(ts) && v > 0) by.set(isoDate(ts), v);
  }
  return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

async function convertGhostfolio(j) {
  if (!j || !Array.isArray(j.activities)) throw Object.assign(new Error('Soubor není Ghostfolio export (chybí activities)'), { status: 400 });
  const accounts = (j.accounts || []).map(a => {
    const bal = Array.isArray(a.balances) && a.balances.length ? [...a.balances].sort((x, y) => String(x.date).localeCompare(String(y.date))).pop().value : a.balance;
    return { id: a.id, name: a.name || 'Účet', currency: a.currency || 'USD', balance: +bal || 0, excluded: !!a.isExcluded };
  });
  const accName = Object.fromEntries(accounts.map(a => [a.id, a.name]));
  // asset profiles (name, currency, class, market data of manual assets) by data source + symbol
  const profs = new Map();
  for (const p of Array.isArray(j.assetProfiles) ? j.assetProfiles : []) if (p && p.symbol) profs.set(`${String(p.dataSource || '').toUpperCase()}:${p.symbol}`, p);
  const rows = j.activities.map(a => {
    const ds = String(a.dataSource || (a.SymbolProfile && a.SymbolProfile.dataSource) || 'YAHOO').toUpperCase();
    const sym = String(a.symbol || (a.SymbolProfile && a.SymbolProfile.symbol) || '');
    const prof = profs.get(`${ds}:${sym}`) || a.SymbolProfile || null;
    return { a, ds, sym, prof, map: gfSymbol(ds, sym, prof) };
  });
  // every market symbol is checked by a quote; a spelling Yahoo does not know is replaced by the alternative that it knows
  const check = [...new Set(rows.flatMap(r => (r.map.y && !/^(MANUAL|CG):/.test(r.map.y) ? [r.map.y, ...(r.map.alt || [])] : [])))].filter(s => SYM_RE.test(s));
  const qs = check.length ? await getQuotes(check).catch(() => ({})) : {};
  const cgIds = [...new Set(rows.filter(r => r.map.y && r.map.y.startsWith('CG:')).map(r => r.map.y.slice(3)))];
  // CoinGecko in parallel and briefly: an outage costs the import a few seconds, not 35 s (the client is waiting). A price
  // that arrives later still clears its "CoinGecko cenu nevrátil" note (cgSettle)
  const cgP = cgIds.length ? cgSimple(cgIds).catch(() => null) : null;
  const [cgNow, cgList] = cgIds.length ? await Promise.all([timeoutP(cgP, CG_WAIT, null), timeoutP(getCryptoMarkets().catch(() => []), CG_WAIT, [])]) : [null, []];
  if (cgP && !cgNow) cgP.then(cgSettle);
  const out = [], unknown = new Set(), manual = {}, cg = {};
  for (const { a, ds, sym, prof, map } of rows) {
    const type = String(a.type || '').toUpperCase();
    let y = map.y, label = null;
    const tag = `${ds}:${sym}`;
    if (!y) { unknown.add(`${tag} – neznámý symbol`); y = 'MANUAL:' + sym; }
    else if (y.startsWith('MANUAL:')) {
      const prices = gfPrices(prof && prof.marketData);
      label = (prof && cleanName(prof.name)) || null;
      manual[y] = { name: label, currency: (prof && prof.currency) || a.currency || null, type: GF_TYPE[String((prof && (prof.assetSubClass || prof.assetClass)) || '').toUpperCase()] || null, prices };
      if (!prices.length && ['BUY', 'SELL', 'ITEM', 'LIABILITY'].includes(type)) unknown.add(`${label || tag} – bez tržní ceny v Ghostfoliu, oceněno transakční cenou`);
    } else if (y.startsWith('CG:')) {
      // name and ticker: CoinGecko's list, else Ghostfolio's profile, else the id ("matic-network" → "Matic Network");
      // stored with the import, so the portfolio stays readable while CoinGecko is down
      const id = y.slice(3), m = (cgList || []).find(c => c.id === id), pn = prof && cleanName(prof.name);
      cg[id] = { name: (m && m.name) || (pn && pn.toLowerCase() !== id ? pn : null) || cgPretty(id), symbol: (m && m.symbol) || (cg[id] && cg[id].symbol) || null };
      label = cg[id].symbol || cg[id].name;
      if (!(cgNow && cgNow[id] && cgNow[id].usd > 0)) unknown.add(`${tag}${CG_MISS}`);
    } else if (!qs[y]) {
      const alt = (map.alt || []).find(s => qs[s]);
      if (alt) y = alt;
      else if (badSym.has(y)) unknown.add(`${tag} – Yahoo symbol ${y} nezná, oceněno transakční cenou`);
    }
    const ts = Date.parse(a.date);
    const cur = a.currency || (prof && prof.currency) || null;
    if (!cur) unknown.add(`${tag} – chybí měna, použito USD`);
    out.push({
      id: 'gf-' + hash(JSON.stringify([a.id || '', a.date, sym, type, a.quantity, a.unitPrice, a.accountId])), date: Number.isFinite(ts) ? localDate(ts) : String(a.date).slice(0, 10),
      type, symbol: y, origSymbol: sym, dataSource: ds, qty: +a.quantity || 0, price: +a.unitPrice || 0, fee: +a.fee || 0,
      currency: cur || 'USD', account: accName[a.accountId] || '', comment: a.comment || '', source: 'ghostfolio', ...(label ? { label } : {}),
    });
  }
  return { activities: out, accounts, unknown: [...unknown], manual, cg, baseCurrency: (j.user && j.user.settings && j.user.settings.currency) || null, meta: j.meta || null };
}
// CoinGecko prices for ids Yahoo does not quote (the public API gives at most 365 days of history)
const CG_WAIT = 6000; // how long the import / sync waits for CoinGecko (the request itself may finish later)
const CG_MISS = ' – CoinGecko cenu nevrátil';
const cgPretty = id => String(id).split('-').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
// display name of a CoinGecko coin: "Uniswap (UNI)" – from the market list, the import, or the id
function cgName(id, list) {
  const m = (list || []).find(c => c.id === id), st = ext.cg && ext.cg[id];
  const name = (m && m.name) || (st && st.name) || cgPretty(id), sym = (m && m.symbol) || (st && st.symbol) || null;
  return sym && sym.toLowerCase() !== name.toLowerCase() ? `${name} (${sym})` : name;
}
// a price that arrived (analysis, refresh, a late answer after an import or sync) clears the "CoinGecko cenu nevrátil" note
function cgSettle(prices) {
  if (!prices || !Array.isArray(ext.unknown) || !ext.unknown.length) return;
  const keep = ext.unknown.filter(u => {
    const m = String(u).endsWith(CG_MISS) && /^COINGECKO:(.+)$/.exec(String(u).slice(0, -CG_MISS.length));
    const id = m && m[1].toLowerCase();
    return !(id && prices[id] && prices[id].usd > 0);
  });
  if (keep.length === ext.unknown.length) return;
  ext.unknown = keep;
  writeJSONAtomic(EXT_FILE, ext); // not saveExt: the analysis cache does not depend on the notes
}
function cgSimple(ids) {
  const list = [...new Set(ids)].filter(id => CG_ID.test(id)).sort();
  return cached('cg:simple:' + list.join(','), 60e3, async () => {
    const j = await fetchJSON(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(list.join(','))}&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true`, { timeout: 12000 });
    mark('coingecko', true);
    return j || {};
  });
}
function cgHistory(id, days) {
  const d = days <= 90 ? 90 : 365;
  return cached(`cg:hist:${id}:${d}`, 3 * 3600e3, async () => {
    const j = await fetchJSON(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=${d}&interval=daily`, { timeout: 20000 });
    const px = (j.prices || []).filter(p => Array.isArray(p) && p[1] > 0);
    mark('coingecko', true);
    return { symbol: 'CG:' + id, currency: 'USD', tz: 'UTC', t: px.map(p => p[0]), c: px.map(p => p[1]), o: px.map(p => p[1]), h: px.map(p => p[1]), l: px.map(p => p[1]), v: px.map(() => 0), splits: [], meta: { type: 'CRYPTOCURRENCY' } };
  });
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
// profileOf throws on errors (peers need to know), getProfile never does (portfolio)
function getProfile(sym) { return profileOf(sym).catch(() => ({})); }
function profileOf(sym) {
  return cached('prof:' + sym, 24 * 3600e3, async () => {
    const j = await yahooJSON(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=assetProfile,quoteType,topHoldings,fundProfile`);
    const r = (j && j.quoteSummary && j.quoteSummary.result && j.quoteSummary.result[0]) || {};
    const ap = r.assetProfile || {}, th = r.topHoldings || {}, sw = {};
    for (const o of th.sectorWeightings || []) for (const [k, v] of Object.entries(o)) { const w = yraw(v); if (w > 0) { const n = ETF_SECTOR[k] || k; sw[n] = (sw[n] || 0) + w; } }
    // name and website identify other listings of the same firm among valuation peers (peerFilter)
    return { sector: ap.sector || null, industry: ap.industry || null, country: ap.country || null, sectorWeights: Object.keys(sw).length ? sw : null, category: (r.fundProfile && r.fundProfile.categoryName) || null,
      name: (r.quoteType && (r.quoteType.longName || r.quoteType.shortName)) || null, website: ap.website || null };
  });
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

const CLASS_OF = { EQUITY: 'Akcie', ETF: 'ETF', CRYPTOCURRENCY: 'Krypto', MUTUALFUND: 'Fondy', FUTURE: 'Komodity', CURRENCY: 'Měny', INDEX: 'Index', BOND: 'Dluhopisy' };
// a daily chart aligned to calendar days: the close of that day, else of the last trading day before it (also for the first
// portfolio day, e.g. a Saturday – never the first close of the whole series); before the first bar the first close
function alignDaily(x, days, val = i => x.c[i]) {
  const pts = x.t.map((ts, i) => [localDate(ts, x.tz || 'UTC'), i]);
  let j = 0, last = null;
  return days.map(d => { while (j < pts.length && pts[j][0] <= d) { last = val(pts[j][1]); j++; } return last ?? val(0); });
}
function rangeFor(days) { return days <= 360 ? '1y' : days <= 720 ? '2y' : days <= 1800 ? '5y' : days <= 3600 ? '10y' : 'max'; }
function xirr(flows) {
  if (flows.length < 2 || !flows.some(f => f.v > 0) || !flows.some(f => f.v < 0)) return null;
  const t0 = flows[0].t, f = r => flows.reduce((s, x) => s + x.v / Math.pow(1 + r, (x.t - t0) / (365 * 864e5)), 0);
  let lo = -0.99, hi = 10, flo = f(lo), fhi = f(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < 100; i++) { const m = (lo + hi) / 2, fm = f(m); if (flo * fm <= 0) { hi = m; } else { lo = m; flo = fm; } }
  return (lo + hi) / 2;
}

// analysis cache: the key is the content (activities, accounts, manual prices, time zone), not the time; short lifetime and
// at most PFA_MAX entries, so a client polling for days does not pile up results
const PFA_MAX = 6;
function prunePfa(keep) {
  const list = [...cache.entries()].filter(([k]) => k.startsWith('pfa:') && k !== keep).sort((a, b) => b[1].t - a[1].t);
  for (const [k] of list.slice(PFA_MAX - 1)) cache.delete(k);
}
async function portfolioAnalysis(base, bench) {
  const acts = allActivities();
  const key = `pfa:${base}:${bench}:${hash(JSON.stringify([acts, ext.accounts || [], ext.manual || {}, (state.settings && state.settings.timezone) || '']))}`;
  prunePfa(key);
  return cached(key, v => (v.fx && (v.fx.missing.length || v.fx.stale.length) ? 15e3 : 60e3), async () => {
    const cashAcc = (ext.accounts || []).filter(a => a.balance > 0 && !a.excluded);
    if (!acts.length && !cashAcc.length) return { empty: true, base };
    const today = localDate(Date.now());
    const first = acts.length ? acts[0].date : today;
    const days = [];
    for (let t = Date.parse(first + 'T12:00:00Z'); ; t += 864e5) { const d = isoDate(t); days.push(d); if (d >= today) break; if (days.length > 6000) break; }
    const range = rangeFor(days.length);
    const syms = [...new Set(acts.filter(a => ['BUY', 'SELL', 'ITEM', 'LIABILITY'].includes(a.type)).map(a => a.symbol))];
    const market = syms.filter(s => !/^(CASH|MANUAL|CG):/.test(s));
    const cgSyms = syms.filter(s => s.startsWith('CG:'));
    // CoinGecko is bounded in time: while it is down the coins are valued at the purchase price (flagged), not after 40 s
    const [quotes, charts, profiles, cgNow, cgCharts, cgList] = await Promise.all([
      getQuotes(market).catch(() => ({})),
      mapLimit(market, 4, s => getChart(s, range, '1d')),
      mapLimit(market, 3, s => getProfile(s)),
      cgSyms.length ? timeoutP(cgSimple(cgSyms.map(s => s.slice(3))).catch(() => null), 10000, null) : null,
      timeoutP(mapLimit(cgSyms, 2, s => cgHistory(s.slice(3), days.length)), 12000, []),
      cgSyms.length ? timeoutP(getCryptoMarkets().catch(() => []), 10000, []) : [],
    ]);
    cgSettle(cgNow);
    const ch = {}, prof = {};
    market.forEach((s, i) => { ch[s] = charts[i]; prof[s] = profiles[i] || {}; });
    // CoinGecko-priced crypto: history and the current price (USD)
    cgSyms.forEach((s, i) => {
      const id = s.slice(3), p = cgNow && cgNow[id];
      if (cgCharts[i] && cgCharts[i].c.length) ch[s] = cgCharts[i];
      prof[s] = {};
      if (p && p.usd > 0) {
        const pct = Number.isFinite(p.usd_24h_change) ? p.usd_24h_change : null;
        quotes[s] = { symbol: s, name: cgName(id, cgList), price: p.usd, currency: 'USD', type: 'CRYPTOCURRENCY', changePct: pct, change: pct != null ? p.usd - p.usd / (1 + pct / 100) : null, time: p.last_updated_at ? p.last_updated_at * 1000 : null };
      }
    });
    // manual assets from Ghostfolio: the market data of their asset profile (name, currency, last price)
    for (const s of syms.filter(s => s.startsWith('MANUAL:'))) {
      const mi = ext.manual && ext.manual[s];
      prof[s] = {};
      if (!mi || !mi.prices || !mi.prices.length) continue;
      const t = mi.prices.map(p => Date.parse(p[0] + 'T12:00:00Z')), c = mi.prices.map(p => p[1]);
      ch[s] = { symbol: s, currency: mi.currency || undefined, tz: 'UTC', t, c, o: c, h: c, l: c, v: c.map(() => 0), splits: [], meta: { type: mi.type || 'MANUAL' }, manual: true };
    }
    // display names: manual assets by their Ghostfolio name (never the UUID alone), CoinGecko coins by their ticker and
    // "Uniswap (UNI)" (also while CoinGecko is down: the import stored name and ticker)
    const manualName = s => (s.startsWith('MANUAL:') ? (ext.manual && ext.manual[s] && ext.manual[s].name) || null : s.startsWith('CG:') ? cgName(s.slice(3), cgList) : null);
    const labelOf = s => (s.startsWith('MANUAL:') ? manualName(s) || 'Ruční aktivum ' + s.slice(7, 15) : s.startsWith('CG:') ? (((cgList || []).find(c => c.id === s.slice(3)) || {}).symbol || (ext.cg && ext.cg[s.slice(3)] && ext.cg[s.slice(3)].symbol) || cgPretty(s.slice(3))) : null);
    // currency of each holding (quote currency wins), constant for manual/cash
    const lastActPrice = {}, actCur = {};
    for (const a of acts) if (['BUY', 'SELL', 'ITEM', 'LIABILITY'].includes(a.type)) { lastActPrice[a.symbol] = a.price; actCur[a.symbol] = a.currency; }
    const curOf = s => (s.startsWith('CASH:') ? s.slice(5) : (quotes[s] && quotes[s].currency) || (ch[s] && ch[s].currency) || actCur[s] || 'USD');
    // FX series to base: historical closes, today the current rate. Never 1 : 1 – a currency without any rate stays missing
    // (its positions are reported, not valued); the persisted last good rate is used with its date (stale)
    const fxArr = {}, fxInfo = {};
    const fxSeriesFor = async c => {
      if (fxArr[c] || fxInfo[c]) return;
      const [cn, cm] = unitNorm(c), [bn, bm] = unitNorm(base), mult = cm / bm;
      if (cn === bn) { fxArr[c] = days.map(() => mult); return; }
      fxInfo[c] = {};
      let series = null;
      for (const [s, inv] of [[`${cn}${bn}=X`, false], ...(cn === 'USD' ? [[`${bn}=X`, false]] : []), [`${bn}${cn}=X`, true]]) {
        try { const x = await getChart(s, range, '1d'); if (x && x.c.length > 5) { series = { x, inv }; break; } } catch { /* try next */ }
      }
      const now = await fxConv(c, base).catch(() => null);
      if (!series && !now) { fxInfo[c] = { missing: true }; return; }
      if (!series) { fxArr[c] = days.map(() => now.k); fxInfo[c] = now.stale ? { stale: true, asOf: now.t, noHistory: true } : { noHistory: true }; return; }
      fxArr[c] = alignDaily(series.x, days, i => (series.inv ? 1 / series.x.c[i] : series.x.c[i]) * mult);
      // today: the current rate; without one the newer of the last close and the saved rate, dated (asOf null = unknown)
      const lastT = series.x.t[series.x.t.length - 1];
      if (now && !now.stale) fxArr[c][days.length - 1] = now.k;
      else if (now && (now.t ?? 0) > lastT) { fxArr[c][days.length - 1] = now.k; fxInfo[c] = { stale: true, asOf: now.t }; }
      else fxInfo[c] = { stale: true, asOf: lastT };
    };
    const curs = new Set([...syms.map(curOf), ...acts.map(a => a.currency), ...cashAcc.map(a => a.currency)]);
    await Promise.all([...curs].map(fxSeriesFor));
    const fxMissing = c => !fxArr[c];
    const fxAt = (c, i) => (fxArr[c] ? fxArr[c][i] : NaN); // never 1: currencies without a rate are skipped below
    // price series aligned to calendar days (carry forward)
    const pxArr = {};
    for (const s of syms) {
      const x = ch[s];
      if (!x || !x.c.length) { const lp = lastActPrice[s] || 0; pxArr[s] = days.map(() => lp); continue; }
      pxArr[s] = alignDaily(x, days);
      const q = quotes[s];
      if (q && isFinite(q.price)) pxArr[s][days.length - 1] = q.price;
    }
    if (syms.some(s => s.startsWith('CASH:'))) syms.filter(s => s.startsWith('CASH:')).forEach(s => { pxArr[s] = days.map(() => 1); });
    // splits: a trade entered at the pre-split price (price ≈ split ratio × split-adjusted close of that trading day, or of the
    // last one before it) is re-based to qty × ratio, price ÷ ratio; trades already adjusted (e.g. by Ghostfolio) match the
    // adjusted close and stay untouched. Ratios up to 1.25 : 1 (stock dividends) cannot be told from price noise: warning only.
    const splitAdj = [], splitWarn = [];
    acts.forEach((a, j) => {
      const x = ch[a.symbol];
      if ((a.type !== 'BUY' && a.type !== 'SELL') || !x || !x.splits || !x.splits.length || !(a.price > 0)) return;
      const later = x.splits.filter(sp => localDate(sp.t, x.tz || 'UTC') > a.date);
      const ratio = later.reduce((r, sp) => r * sp.num / sp.den, 1), i = days.indexOf(a.date);
      const [ac, am] = unitNorm(a.currency), [qc, qm] = unitNorm(curOf(a.symbol));
      if (Math.abs(Math.log(ratio)) < 1e-6 || ac !== qc || i < 0) return;
      const info = { date: a.date, symbol: a.symbol, type: a.type, qty: a.qty, price: a.price, currency: a.currency, ratio, splits: later.map(sp => ({ date: localDate(sp.t, x.tz || 'UTC'), ratio: `${sp.num}:${sp.den}` })), source: a.source };
      if (Math.abs(Math.log(ratio)) <= Math.log(1.25) + 1e-9) { splitWarn.push(info); return; }
      const close = pxArr[a.symbol][i] * qm / am, m = a.price / close, tol = Math.min(Math.log(1.25), Math.abs(Math.log(ratio)) / 2);
      if (!(close > 0) || Math.abs(Math.log(m / ratio)) > tol || Math.abs(Math.log(m)) < tol) return;
      acts[j] = { ...a, qty: a.qty * ratio, price: a.price / ratio };
      splitAdj.push({ ...info, newQty: a.qty * ratio, newPrice: a.price / ratio });
    });
    // data-quality: trades priced far away from that day's market close
    const warnings = [];
    for (const a of acts) {
      if ((a.type !== 'BUY' && a.type !== 'SELL') || !ch[a.symbol] || ch[a.symbol].manual || unitNorm(a.currency)[0] !== unitNorm(curOf(a.symbol))[0]) continue;
      const i = days.indexOf(a.date), mk = i >= 0 ? pxArr[a.symbol][i] * unitNorm(curOf(a.symbol))[1] / unitNorm(a.currency)[1] : null;
      if (mk > 0 && a.price > 0 && Math.abs(a.price / mk - 1) > 0.25) warnings.push({ date: a.date, symbol: a.symbol, type: a.type, qty: a.qty, price: a.price, market: mk, dev: (a.price / mk - 1) * 100, currency: a.currency, source: a.source });
    }
    // benchmark in base currency with the historical FX series, also when the portfolio holds nothing in its currency
    let bx = null; try { bx = await getChart(bench, range, '1d'); } catch { /* none */ }
    let bArr = null, benchErr = null, benchCur = null;
    if (bx && bx.c.length) {
      benchCur = bx.currency || 'USD';
      await fxSeriesFor(benchCur);
      if (fxMissing(benchCur)) benchErr = `kurz ${unitNorm(benchCur)[0]}→${base} není k dispozici`;
      else bArr = alignDaily(bx, days).map((v, i) => v * fxAt(benchCur, i));
    }
    // positions touching a currency without any rate are left out of everything and reported
    const fxBadSym = new Set(syms.filter(s => fxMissing(curOf(s)) || acts.some(a => a.symbol === s && fxMissing(a.currency))));
    const skipAct = a => fxBadSym.has(a.symbol) || fxMissing(a.currency);
    // fxStale = time of the rate's data, or true when that time is unknown (an fx-last.json entry without t)
    const fxFlag = c => (fxInfo[c] && fxInfo[c].stale ? { fxStale: fxInfo[c].asOf ?? true, fxAsOf: fxInfo[c].asOf ?? null } : {});
    // day-by-day replay; liabilities are not investments (net worth only)
    const byDay = {};
    for (const a of acts) if (a.type !== 'LIABILITY' && !skipAct(a)) (byDay[a.date] = byDay[a.date] || []).push(a);
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
      if (!x || fxBadSym.has(s)) continue;
      const cur = curOf(s), fxNow = fxAt(cur, li), q = quotes[s] || {}, p = prof[s] || {};
      const price = pxArr[s][li], value = x.qty * price * fxNow;
      if (Math.abs(x.qty) < 1e-9) { if (x.realized || x.div) closed.push({ symbol: s, name: q.name || manualName(s) || s, ...(labelOf(s) ? { label: labelOf(s) } : {}), realized: x.realized, dividends: x.div }); continue; }
      const type = s.startsWith('CASH:') ? 'CASH' : s.startsWith('CG:') ? 'CRYPTOCURRENCY' : q.type || (ch[s] && ch[s].meta && ch[s].meta.type) || (s.startsWith('MANUAL:') ? 'MANUAL' : null);
      const cls = type === 'CASH' ? 'Hotovost' : type === 'MANUAL' ? 'Ostatní' : CLASS_OF[type] || 'Ostatní';
      const sector = cls === 'Krypto' ? 'Krypto' : cls === 'Hotovost' ? 'Hotovost' : cls === 'ETF' || cls === 'Fondy' ? (p.sectorWeights ? null : 'ETF / fondy') : SECTOR_CS[p.sector] || p.sector || 'Neznámý';
      const country = cls === 'Krypto' ? 'Krypto' : cls === 'Hotovost' ? 'Hotovost' : cls === 'ETF' || cls === 'Fondy' ? etfRegion(q.longName || q.name || manualName(s)) : COUNTRY_CS[p.country] || p.country || 'Neznámá';
      const dayB = q && isFinite(q.change) ? x.qty * q.change * fxNow : 0;
      const dy = isFinite(q.divYield) ? q.divYield : null;
      const pdiv = dy ? value * dy / 100 : 0;
      const years = (Date.now() - Date.parse(x.first + 'T12:00:00Z')) / (365 * 864e5);
      const irr = years >= 0.25 ? xirr([...x.flows, { t: Date.now(), v: value }]) : null;
      holdings.push({
        symbol: s, name: s.startsWith('CASH:') ? 'Hotovost ' + cur : q.longName || q.name || manualName(s) || s, ...(labelOf(s, q) ? { label: labelOf(s, q) } : {}), type, cls, sector, sectorWeights: sector === null ? p.sectorWeights : null, country, currency: cur,
        accounts: [...x.accounts], qty: x.qty, avg: x.qty ? x.costL / x.qty : null, actCurrency: actCur[s], price, value, cost: x.costB, pl: value - x.costB, plPct: x.costB > 0 ? (value - x.costB) / x.costB * 100 : null,
        dayChange: dayB, dayPct: q.changePct ?? null, realized: x.realized, dividends: x.div, fees: x.fees, first: x.first, irr, divYield: dy, projDiv: pdiv,
        // valued without a market price (purchase price) – never silently: X-ray lists these
        noQuote: s.startsWith('CASH:') ? false : s.startsWith('MANUAL:') ? !(ch[s] && ch[s].c.length) : !quotes[s],
        ...fxFlag(cur),
      });
      total += value; dayChg += dayB; projDiv += pdiv;
    }
    // FX problems per currency: positions left out (missing) or valued with an old rate (stale)
    const fxMiss = {};
    const addMiss = (c, s) => (fxMiss[c] = fxMiss[c] || new Set()).add(s);
    for (const s of fxBadSym) [curOf(s), ...acts.filter(a => a.symbol === s).map(a => a.currency)].filter(fxMissing).forEach(c => addMiss(c, s));
    for (const a of acts) if (fxMissing(a.currency) && !fxBadSym.has(a.symbol)) addMiss(a.currency, a.symbol);
    let cashTotal = 0;
    for (const a of cashAcc) {
      if (fxMissing(a.currency)) { addMiss(a.currency, `CASH:${a.currency} (${a.name})`); continue; }
      const value = a.balance * fxAt(a.currency, li);
      holdings.push({ symbol: 'CASH:' + a.currency, name: `Hotovost – ${a.name}`, type: 'CASH', cls: 'Hotovost', sector: 'Hotovost', country: 'Hotovost', currency: a.currency, accounts: [a.name], qty: a.balance, avg: 1, price: 1, value, cost: value, pl: 0, plPct: 0, dayChange: 0, dividends: 0, realized: 0, first: null, cash: true, ...fxFlag(a.currency) });
      cashTotal += value; total += value;
    }
    // liabilities (LIABILITY, e.g. a loan): outside TWR, XIRR, ROAI, risk and allocation; net worth = value − liabilities
    const liabilities = [];
    let liabTotal = 0;
    for (const s of [...new Set(acts.filter(a => a.type === 'LIABILITY').map(a => a.symbol))]) {
      const la = acts.filter(a => a.type === 'LIABILITY' && a.symbol === s), market = !!(ch[s] && ch[s].c.length), cur = market ? curOf(s) : la[la.length - 1].currency;
      if (fxBadSym.has(s) || la.some(a => fxMissing(a.currency))) continue;
      const value = market ? la.reduce((t, a) => t + a.qty, 0) * pxArr[s][li] * fxAt(cur, li) : la.reduce((t, a) => t + a.qty * a.price * fxAt(a.currency, li), 0);
      liabilities.push({ symbol: s, name: s.startsWith('MANUAL:') ? manualName(s) || s.slice(7) : (quotes[s] && (quotes[s].longName || quotes[s].name)) || s, ...(labelOf(s) ? { label: labelOf(s) } : {}), currency: cur, value, first: la[0].date, ...fxFlag(cur) });
      liabTotal += value;
    }
    liabilities.sort((a, b) => b.value - a.value);
    const fxNote = { missing: [], stale: [] };
    for (const [c, s] of Object.entries(fxMiss)) fxNote.missing.push({ currency: c, main: unitNorm(c)[0], symbols: [...s] });
    for (const [c, f] of Object.entries(fxInfo)) {
      if (!f.stale) continue;
      const list = [...holdings, ...liabilities].filter(x => x.currency === c).map(x => x.symbol);
      if (list.length || c === benchCur) fxNote.stale.push({ currency: c, main: unitNorm(c)[0], asOf: f.asOf ?? null, noHistory: !!f.noHistory, symbols: list, bench: c === benchCur });
    }
    for (const x of holdings) x.weight = total ? x.value / total * 100 : 0;
    holdings.sort((a, b) => b.value - a.value);
    // allocations
    const agg = fn => { const m = {}; for (const x of holdings) for (const [k, v] of fn(x)) m[k] = (m[k] || 0) + v; return Object.entries(m).map(([label, value]) => ({ label, value, pct: total ? value / total * 100 : 0 })).sort((a, b) => b.value - a.value); };
    const alloc = {
      holding: holdings.map(x => ({ label: x.label || x.symbol.replace(/^CASH:/, 'Hotovost ').replace(/^MANUAL:/, ''), value: x.value, pct: x.weight })),
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
    acts.filter(a => (a.type === 'DIVIDEND' || a.type === 'INTEREST') && !skipAct(a)).forEach(a => { const i = days.indexOf(a.date); const amt = a.qty * a.price * fxAt(a.currency, i < 0 ? li : i); divMonths[a.date.slice(0, 7)] = (divMonths[a.date.slice(0, 7)] || 0) + amt; });
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
        benchValue: out.benchValue[out.benchValue.length - 1], gf: ext.gfPerformance || null, liabilities: liabTotal, netWorth: total - liabTotal,
      },
      holdings, closed, alloc, series: ds, divMonths, warnings, unknown: ext.unknown || [], liabilities, fx: fxNote, benchErr, splitAdj, splitWarn,
    };
  }, 10 * 60e3);
}

// ───────────────────────────── Own Bitcoin node (RPC) ─────────────────────────────
// host:port of a URL (default port by scheme), '' when not a URL
function hostPort(u) {
  try { const x = new URL(String(u || '').trim()); return `${x.hostname.toLowerCase()}:${x.port || (x.protocol === 'https:' ? '443' : '80')}`; } catch { return ''; }
}
function btcConf() {
  const s = (state.settings && state.settings.bitcoin) || {};
  const host = process.env.BITCOIN_RPC_HOST, port = process.env.BITCOIN_RPC_PORT || '8332';
  const envUrl = host ? `http://${host}:${port}` : '';
  const url = String(s.rpcUrl || envUrl).trim().replace(/\/+$/, '');
  // Umbrel's credentials (APP_BITCOIN_* → BITCOIN_RPC_*) only ever go to the node from the environment
  const envOk = !!envUrl && hostPort(url) === hostPort(envUrl);
  const user = s.rpcUser || (envOk ? process.env.BITCOIN_RPC_USER : '') || '', pass = s.rpcPass || (envOk ? process.env.BITCOIN_RPC_PASS : '') || '';
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
// a stored password/token belongs to its server: when the origin (scheme, host, port) changes and the same request does not
// send a new secret (only the mask or nothing), the stored one is dropped instead of going to the new host. Another path
// or ntfy topic on the same server keeps it.
const SECRET_URLS = [['bitcoin', 'rpcUrl', 'rpcPass'], ['notify', 'ntfyUrl', 'ntfyToken'], ['ghostfolio', 'url', 'token']];
const urlOrigin = u => { const t = String(u || '').trim(); try { const x = new URL(t); return `${x.protocol}//${x.host}`; } catch { return t.replace(/\/+$/, ''); } };
function dropMovedSecrets(next, prev) {
  if (!next || typeof next !== 'object') return next;
  for (const [sec, uf, sf] of SECRET_URLS) {
    const n = next[sec], p = prev && prev[sec];
    if (!n || typeof n !== 'object' || !p || !p[sf]) continue;
    const fresh = n[sf] != null && n[sf] !== '' && n[sf] !== MASK;
    if (!fresh && urlOrigin(n[uf]) !== urlOrigin(p[uf])) n[sf] = '';
  }
  return next;
}

// ───────────────────────────── State storage ─────────────────────────────
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const STATE_KEYS = new Set(['portfolio', 'watchlist', 'alerts', 'journal', 'settings', 'links', 'layout', 'notes']);
let state = {};
let dataWritable = true;
// returns success; dataWritable (shown to the client) follows only writes of user data, not caches like fx-last.json
function writeJSONAtomic(file, obj, { track = true } = {}) {
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
    if (track) dataWritable = true;
    return true;
  } catch (e) {
    if (track) dataWritable = false;
    log('write failed', file, e.message);
    return false;
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

// ───────────────────────────── portfolio PIN ─────────────────────────────
// Server-side lock of the private state. Config in its own file, sessions and attempt limits only in memory.
const PIN_FILE = path.join(DATA_DIR, 'pin.json');
const PIN_RE = /^\d{4,8}$/;
const PIN_SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const PIN_DEFAULT_MIN = 20;
const PIN_GATED = /^\/api\/(portfolio(\/|$)|state\/(portfolio|journal|notes)$)/;
let pinConf = null;    // { salt, hash, minutes } (hex strings)
let pinBroken = false; // pin.json exists but is unusable → fail closed: counts as set, no PIN passes
const pinSessions = new Map(); // token → absolute expiry (ms); activity does not extend it
const pinGuard = { fails: 0, until: 0, busy: false };
const pinErr = (status, message, extra) => Object.assign(new Error(message), { status, extra });
const pinValid = pin => typeof pin === 'string' && PIN_RE.test(pin);
const pinEnabled = () => !!pinConf || pinBroken;
const pinRetryIn = () => Math.max(0, Math.ceil((pinGuard.until - Date.now()) / 1000));
const pinToken = req => { const m = String(req.headers.cookie || '').match(/(?:^|;\s*)finterm_pin=([0-9a-f]{64})(?=\s*(?:;|$))/); return m ? m[1] : null; };
const pinDerive = (pin, salt) => new Promise((ok, fail) => crypto.scrypt(pin, salt, 32, PIN_SCRYPT, (e, key) => (e ? fail(e) : ok(key))));
async function pinHash(pin, minutes) { const salt = crypto.randomBytes(16); return { salt: salt.toString('hex'), hash: (await pinDerive(pin, salt)).toString('hex'), minutes }; }
function pinMinutes(v, def) { const m = v == null ? def : v; if (!Number.isInteger(m) || m < 1 || m > 480) throw pinErr(400, 'Délka odemčení musí být celé číslo 1 až 480 minut'); return m; }
function loadPin() {
  let txt;
  try { txt = fs.readFileSync(PIN_FILE, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') { pinBroken = true; log('PIN config unreadable, portfolio stays locked:', e.code || e.message); } return; }
  try {
    const j = JSON.parse(txt);
    if (!/^[0-9a-f]{32}$/.test(j.salt) || !/^[0-9a-f]{64}$/.test(j.hash) || !Number.isInteger(j.minutes) || j.minutes < 1 || j.minutes > 480) throw new Error('invalid');
    pinConf = { salt: j.salt, hash: j.hash, minutes: j.minutes };
  } catch { pinBroken = true; log('PIN config corrupted, portfolio stays locked:', PIN_FILE); } // parser messages could quote the file
}
// writeJSONAtomic swallows errors: the new config may enter memory only after a confirmed write
function pinSave(next) { if (!writeJSONAtomic(PIN_FILE, next)) throw pinErr(500, 'PIN se nepodařilo uložit – datový adresář není zapisovatelný'); pinConf = next; pinBroken = false; }
function pinLeft(token) { const exp = token ? pinSessions.get(token) : 0; if (!exp) return 0; const left = exp - Date.now(); if (left <= 0) pinSessions.delete(token); return Math.max(0, left); }
const pinIsOpen = token => !pinEnabled() || pinLeft(token) > 0;
function pinStatus(token) { const enabled = pinEnabled(), left = enabled ? pinLeft(token) : 0; return { enabled, open: !enabled || left > 0, remaining: Math.ceil(left / 1000), minutes: pinConf ? pinConf.minutes : PIN_DEFAULT_MIN, retryIn: pinRetryIn() }; }
function pinIssue(res) {
  const token = crypto.randomBytes(32).toString('hex'), sec = pinConf.minutes * 60;
  pinSessions.set(token, Date.now() + sec * 1000);
  res.setHeader('Set-Cookie', `finterm_pin=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sec}`);
  return token;
}
// one PIN operation at a time, otherwise parallel requests would get around the attempt limit
async function pinExclusive(fn) {
  if (pinGuard.busy) throw pinErr(429, 'Ověření PINu právě probíhá – zkuste to znovu', { retryIn: 1 });
  pinGuard.busy = true;
  try { return await fn(); } finally { pinGuard.busy = false; }
}
async function pinVerify(pin) {
  const wait = pinRetryIn();
  if (wait) throw pinErr(429, `Příliš mnoho pokusů – zkuste to znovu za ${wait} s`, { retryIn: wait });
  if (pinBroken) throw pinErr(403, 'Konfigurace PINu je poškozená – postup je v README');
  if (pinValid(pin) && crypto.timingSafeEqual(await pinDerive(pin, Buffer.from(pinConf.salt, 'hex')), Buffer.from(pinConf.hash, 'hex'))) { pinGuard.fails = 0; pinGuard.until = 0; return; }
  if (++pinGuard.fails >= 5) pinGuard.until = Date.now() + Math.min(30e3 * 2 ** (pinGuard.fails - 5), 15 * 60e3);
  throw pinErr(403, 'Nesprávný PIN', { retryIn: pinRetryIn() });
}
setInterval(() => { const now = Date.now(); for (const [t, exp] of pinSessions) if (exp <= now) pinSessions.delete(t); }, 60e3).unref();

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
    memory: Math.round(process.memoryUsage().rss / 1048576), dataWritable, dataDir: DATA_DIR, cache: cache.size, cachePfa: [...cache.keys()].filter(k => k.startsWith('pfa:')).length,
    sources: health, time: Date.now(), newsUpdated, archive: Object.keys(archive.events).length,
    mempool: mempoolBase(), mempoolLocal: !!mempoolLocal, btcNode: !!btcConf(), portfolioSource: ext.source, portfolioSynced: ext.syncedAt,
  }),
  'GET /api/quotes': async q => getQuotes(cleanSymbols(q.get('s'))),
  'GET /api/spark': async q => getSpark(cleanSymbols(q.get('s'), 80), RANGES.has(q.get('range')) ? q.get('range') : '1d', INTERVALS.has(q.get('interval')) ? q.get('interval') : '15m'),
  'GET /api/chart': async q => {
    const [s] = cleanSymbols(q.get('s'), 1);
    if (!s) throw Object.assign(new Error('missing symbol'), { status: 400 });
    return getChart(s, RANGES.has(q.get('range')) ? q.get('range') : '1mo', INTERVALS.has(q.get('interval')) ? q.get('interval') : '1d');
  },
  'GET /api/search': async q => { const t = String(q.get('q') || '').trim().slice(0, 40); return t.length < 1 ? [] : ySearch(t); },
  'GET /api/resolve': async q => resolveQuery(q.get('q'), { light: q.get('light') === '1' }),
  'GET /api/perf': async q => getPerf(cleanSymbols(q.get('s'), 40)),
  'GET /api/portfolio/analysis': async q => {
    const base = ['CZK', 'USD', 'EUR', 'GBP', 'CHF'].includes(q.get('base')) ? q.get('base') : (state.settings && state.settings.baseCurrency) || 'CZK';
    const [bench] = cleanSymbols(q.get('bench') || '^GSPC', 1);
    return portfolioAnalysis(base, bench || '^GSPC');
  },
  'GET /api/portfolio/source': async () => {
    // a CoinGecko price that has arrived since the import or sync clears its note
    const miss = (ext.unknown || []).map(u => String(u)).filter(u => u.endsWith(CG_MISS)).map(u => (/^COINGECKO:(.+)$/.exec(u.slice(0, -CG_MISS.length)) || [])[1]).filter(Boolean).map(s => s.toLowerCase());
    if (miss.length) cgSettle(await timeoutP(cgSimple(miss).catch(() => null), 4000, null));
    return { source: ext.source, syncedAt: ext.syncedAt, url: ext.url || null, error: ext.error || null, activities: (ext.activities || []).length, accounts: ext.accounts || [], unknown: ext.unknown || [], baseCurrency: ext.baseCurrency || null, configured: !!(state.settings && state.settings.ghostfolio && state.settings.ghostfolio.token) };
  },
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
    // without a Yahoo price there is nothing to analyse (BRK.B, CSPX, 2330 without an exchange suffix): 404, not an empty page
    const noPrice = () => Object.assign(new Error(`Yahoo nemá pro ${s} cenu – zkuste symbol s příponou burzy`), { status: 404 });
    const qs = await getQuotes([s]).catch(() => null);
    if (qs && !qs[s] && badSym.has(s)) throw noPrice();
    const d = await getFundamentals(s);
    if (!d || !Number.isFinite(d.price) || !(d.price > 0)) throw noPrice();
    return d;
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
  'GET /api/state': async (q, req) => {
    const _pin = { ...pinStatus(pinToken(req)), stored: ['portfolio', 'journal', 'notes'].filter(k => state[k] != null) }, { portfolio, journal, notes, ...open } = state;
    return { ...(_pin.open ? state : open), settings: maskSettings(state.settings), _server: { version: VERSION, writable: dataWritable }, _pin };
  },
  'GET /api/pin': async (q, req) => pinStatus(pinToken(req)),
  'POST /api/pin/setup': async (q, req, res) => {
    const b = (await readJSON(req)) || {};
    return pinExclusive(async () => {
      if (pinEnabled()) throw pinErr(409, 'PIN už je nastavený');
      if (!pinValid(b.pin)) throw pinErr(400, 'PIN musí mít 4 až 8 číslic');
      pinSave(await pinHash(b.pin, pinMinutes(b.minutes, PIN_DEFAULT_MIN)));
      return { ok: true, ...pinStatus(pinIssue(res)) };
    });
  },
  'POST /api/pin/unlock': async (q, req, res) => {
    const b = (await readJSON(req)) || {};
    return pinExclusive(async () => {
      if (!pinEnabled()) throw pinErr(409, 'PIN není nastavený');
      await pinVerify(b.pin);
      return { ok: true, ...pinStatus(pinIssue(res)) };
    });
  },
  'POST /api/pin/lock': async (q, req, res) => {
    const t = pinToken(req);
    if (t) pinSessions.delete(t);
    res.setHeader('Set-Cookie', 'finterm_pin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    return { ok: true, ...pinStatus(null) };
  },
  'POST /api/pin/change': async (q, req, res) => {
    const b = (await readJSON(req)) || {};
    return pinExclusive(async () => {
      if (!pinEnabled()) throw pinErr(409, 'PIN není nastavený');
      if (b.newPin == null && b.minutes == null) throw pinErr(400, 'Není co změnit');
      if (b.newPin != null && !pinValid(b.newPin)) throw pinErr(400, 'Nový PIN musí mít 4 až 8 číslic');
      const minutes = pinMinutes(b.minutes, pinConf ? pinConf.minutes : PIN_DEFAULT_MIN);
      await pinVerify(b.pin);
      if (b.newPin == null) { pinSave({ ...pinConf, minutes }); return { ok: true, ...pinStatus(pinToken(req)) }; }
      pinSave(await pinHash(b.newPin, minutes));
      pinSessions.clear();
      return { ok: true, ...pinStatus(pinIssue(res)) };
    });
  },
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
    if (PIN_GATED.test(p) && !pinIsOpen(pinToken(req))) return sendJSON(req, res, 423, { error: 'Portfolio je zamčené – zadejte PIN', locked: true });
    // a cross-site form cannot send JSON without a preflight: every state-changing request must be JSON
    // (no Origin check, app_proxy may rewrite Host)
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method) && !/^application\/json\b/i.test(req.headers['content-type'] || '')) return sendJSON(req, res, 415, { error: 'Content-Type musí být application/json' });
    const stateKey = p.match(/^\/api\/state\/([a-z]+)$/);
    if (stateKey) {
      const key = stateKey[1];
      if (!STATE_KEYS.has(key)) return sendJSON(req, res, 404, { error: 'unknown key' });
      if (req.method === 'GET') return sendJSON(req, res, 200, (key === 'settings' ? maskSettings(state[key]) : state[key]) ?? null);
      if (req.method === 'PUT') {
        const body = await readJSON(req);
        if (body === null || typeof body !== 'object' || (key === 'settings' && Array.isArray(body))) return sendJSON(req, res, 400, { error: 'object expected' });
        if (key === 'settings' && !pinIsOpen(pinToken(req))) { // locked: a new Ghostfolio URL would send the kept token to a foreign host
          const g = state.settings && state.settings.ghostfolio;
          if (g) body.ghostfolio = g; else delete body.ghostfolio;
        }
        state[key] = key === 'settings' ? keepSecrets(dropMovedSecrets(body, state.settings), state.settings) : body;
        saveState();
        if (key === 'settings') cache.forEach((v, k) => { if (k === 'cryptoglobal' || k === 'btcnode' || k.startsWith('mempool:') || k.startsWith('pfa:')) cache.delete(k); });
        if (key === 'portfolio') cache.forEach((v, k) => { if (k.startsWith('pfa:')) cache.delete(k); });
        return sendJSON(req, res, 200, { ok: true, writable: dataWritable });
      }
      return sendJSON(req, res, 405, { error: 'method not allowed' });
    }
    const fn = routes[`${req.method} ${p}`];
    if (!fn) return sendJSON(req, res, 404, { error: 'unknown endpoint' });
    const out = await fn(url.searchParams, req, res);
    return sendJSON(req, res, 200, out);
  } catch (e) {
    const status = e.status && e.status < 500 ? e.status : 502;
    if (status >= 500) log('API error', p, e.message);
    return sendJSON(req, res, status, { error: e.message || 'error', ...e.extra });
  }
}

// ───────────────────────────── boot ─────────────────────────────
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { log('cannot create data dir', DATA_DIR, e.message); }
loadState();
loadPin();
loadArchive();
loadExt();
loadFxLast();

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
    if (fxLastTimer) flushFxLast();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
