/**
 * Vercel Serverless Function —— 币安数据中转
 *
 * 部署在 Vercel（Region = hnd1 东京），出口是 AWS ap-northeast-1
 * 币安允许该地区访问。
 *
 * 用法：
 *   /api/relay?path=/fapi/v1/klines&symbol=ETHUSDT&interval=1m&limit=1500
 *   /api/relay?path=/fapi/v1/ticker/24hr&symbol=BTCUSDT
 *   /api/relay?path=/dapi/v1/time
 */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const UPSTREAM = {
  fapi: "https://fapi.binance.com/fapi",
  dapi: "https://dapi.binance.com/dapi",
  spot: "https://api.binance.com/api",
};

const ALLOW = ["/fapi/", "/dapi/", "/spot/", "/api/"];

export default async function handler(req, res) {
  const q = req.query || {};
  const bnPath = String(q.path || "");

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  if (!bnPath) {
    res.status(200).json({
      ok: true,
      platform: "vercel",
      region: process.env.VERCEL_REGION || null,
      usage: "/api/relay?path=/fapi/v1/klines&symbol=ETHUSDT&interval=1m&limit=1500",
      allowed: ALLOW,
    });
    return;
  }

  if (!ALLOW.some(p => bnPath.startsWith(p))) {
    res.status(403).json({ error: "path not allowed", path: bnPath, allowed: ALLOW });
    return;
  }

  // 段名 → 上游基址
  //   /fapi/... → https://fapi.binance.com/fapi/...
  //   /dapi/... → https://dapi.binance.com/dapi/...
  //   /spot/... → https://api.binance.com/api/...
  //   /api/...  → https://api.binance.com/api/...
  let base, rest;
  if (bnPath.startsWith("/fapi/")) {
    base = UPSTREAM.fapi; rest = bnPath.slice(5);
  } else if (bnPath.startsWith("/dapi/")) {
    base = UPSTREAM.dapi; rest = bnPath.slice(5);
  } else if (bnPath.startsWith("/spot/")) {
    base = UPSTREAM.spot; rest = bnPath.slice(6);
  } else if (bnPath.startsWith("/api/")) {
    base = UPSTREAM.spot; rest = bnPath.slice(4);
  } else {
    res.status(403).json({ error: "bad path" });
    return;
  }

  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (k === "path") continue;
    if (Array.isArray(v)) v.forEach(x => params.append(k, String(x)));
    else params.append(k, String(v));
  }
  const qs = params.toString();
  const target = base + rest + (qs ? "?" + qs : "");

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 40000);
  try {
    const t0 = Date.now();
    const r = await fetch(target, {
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
    res.setHeader("X-Upstream-Url", target);
    res.setHeader("X-Upstream-Ms", String(Date.now() - t0));
    res.setHeader("Content-Type",
                  r.headers.get("content-type") || "application/json");
    res.status(r.status).send(Buffer.from(buf));
  } catch (e) {
    res.status(502).json({
      error: "upstream failed", target,
      message: e.name + ": " + e.message,
    });
  } finally {
    clearTimeout(timer);
  }
}
