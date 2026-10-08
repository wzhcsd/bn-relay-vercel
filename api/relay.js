/**
 * Vercel Serverless Function —— 通用数据中转（万能通道）
 *
 * 部署在 Vercel（Region = hnd1 东京），出口 AWS ap-northeast-1
 *
 * 模式一（推荐）：通用 target
 *   /api/relay?target=<完整URL编码>&<其余参数原样透传>
 *
 * 模式二：币安快捷方式（兼容旧调用）
 *   /api/relay?path=/fapi/v1/klines&symbol=ETHUSDT&interval=1m&limit=1500
 *
 * 白名单：只放行公开数据 API 域名
 */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// 允许的目标域名（公开数据 API）
const ALLOW_HOSTS = [
  "binance.com",              // fapi / dapi / api / www
  "binance.vision",           // data-api / data
  "okx.com",                  // www / aws
  "mexc.com",                 // api / contract
  "bybit.com",                // api
  "gateio.ws",                // api
  "coingecko.com",            // api
  "coinbase.com",             // api
  "kraken.com",               // api
  "bitstamp.net",             // www
  "htx.com",                  // api
  "kucoin.com",               // api
  "cryptocompare.com",        // min-api
  "coinmarketcap.com",        // pro-api
];

const BINANCE = {
  fapi: "https://fapi.binance.com/fapi",
  dapi: "https://dapi.binance.com/dapi",
  spot: "https://api.binance.com/api",
};

function hostAllowed(host) {
  const h = String(host || "").toLowerCase();
  return ALLOW_HOSTS.some(a => h === a || h.endsWith("." + a));
}

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}

export default async function handler(req, res) {
  const q = req.query || {};
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  const target = String(q.target || "");
  const bnPath = String(q.path || "");

  // ---------- 用法说明 ----------
  if (!target && !bnPath) {
    res.status(200).json({
      ok: true,
      service: "universal-channel",
      platform: "vercel",
      region: process.env.VERCEL_REGION || null,
      egress_note: "AWS ap-northeast-1 (Tokyo)",
      modes: {
        generic: "/api/relay?target=<urlencoded-url>&<params>",
        binance: "/api/relay?path=/fapi/v1/klines&symbol=ETHUSDT&interval=1m&limit=1500",
      },
      allow_hosts: ALLOW_HOSTS,
      examples: [
        "?target=" + encodeURIComponent("https://www.okx.com/api/v5/market/candles") +
          "&instId=BTC-USDT-SWAP&bar=1m&limit=100",
        "?target=" + encodeURIComponent("https://www.okx.com/api/v5/public/time"),
        "?path=/fapi/v1/klines&symbol=ETHUSDT&interval=1m&limit=1500",
      ],
    });
    return;
  }

  // ---------- 组装目标 URL ----------
  let url;
  if (target) {
    try {
      url = new URL(target);
    } catch (e) {
      return void res.status(400).json({ error: "invalid target url", target });
    }
    if (!hostAllowed(url.hostname)) {
      return void res.status(403).json({
        error: "host not allowed", host: url.hostname, allow_hosts: ALLOW_HOSTS,
      });
    }
    // 其余 query 参数合并进去
    for (const [k, v] of Object.entries(q)) {
      if (k === "target") continue;
      if (Array.isArray(v)) v.forEach(x => url.searchParams.append(k, String(x)));
      else url.searchParams.set(k, String(v));
    }
  } else {
    // 币安快捷方式
    let base, rest;
    if (bnPath.startsWith("/fapi/")) { base = BINANCE.fapi; rest = bnPath.slice(5); }
    else if (bnPath.startsWith("/dapi/")) { base = BINANCE.dapi; rest = bnPath.slice(5); }
    else if (bnPath.startsWith("/spot/")) { base = BINANCE.spot; rest = bnPath.slice(6); }
    else if (bnPath.startsWith("/api/")) { base = BINANCE.spot; rest = bnPath.slice(4); }
    else {
      return void res.status(403).json({ error: "bad path", path: bnPath });
    }
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) {
      if (k === "path") continue;
      if (Array.isArray(v)) v.forEach(x => params.append(k, String(x)));
      else params.append(k, String(v));
    }
    const qs = params.toString();
    url = new URL(base + rest + (qs ? "?" + qs : ""));
  }

  const finalUrl = url.toString();

  // ---------- 转发 ----------
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 40000);
  try {
    const t0 = Date.now();
    const r = await fetch(finalUrl, {
      signal: ctl.signal,
      headers: {
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
    const buf = await r.arrayBuffer();
    res.setHeader("X-Upstream-Status", String(r.status));
    res.setHeader("X-Upstream-Url", finalUrl);
    res.setHeader("X-Upstream-Ms", String(Date.now() - t0));
    res.setHeader("X-Egress", "aws-ap-northeast-1");
    res.setHeader("Content-Type",
                  r.headers.get("content-type") || "application/json");
    res.status(r.status).send(Buffer.from(buf));
  } catch (e) {
    res.status(502).json({
      error: "upstream failed", target: finalUrl,
      message: e.name + ": " + e.message,
    });
  } finally {
    clearTimeout(timer);
  }
}
