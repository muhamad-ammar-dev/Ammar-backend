// src/server.js
//
// سيرفر HTTP بسيط (بدون Express) عشان المشروع يشتغل بـ Node built-ins بس.
// لو حابب تنتقل لـ Express لاحقًا، الـ route handlers في routes/*.js
// مكتوبة بشكل مستقل عن الـ HTTP layer (بتاخد body/query وترجع {status,data})
// فسهل توصلها بأي framework.

const http = require("node:http");
const { URL } = require("node:url");
const { sendJson, readJsonBody } = require("./utils/helpers");
const { attachWebSocketServer } = require("./ws/server");
const hub = require("./ws/hub");
const jwt = require("./utils/jwt");
const db = require("./db");

const auth = require("./routes/auth");
const orders = require("./routes/orders");

const PORT = process.env.PORT || 3000;

// [regex, method] -> handler(req, res, body, ...params, query)
const routes = [
  { method: "POST", pattern: /^\/auth\/otp$/, handler: (req, res, body) => auth.requestOtp(req, res, body) },
  { method: "POST", pattern: /^\/auth\/verify$/, handler: (req, res, body) => auth.verifyOtp(req, res, body) },
  { method: "POST", pattern: /^\/auth\/refresh$/, handler: (req, res, body) => auth.refresh(req, res, body) },
  { method: "POST", pattern: /^\/auth\/logout$/, handler: (req, res, body) => auth.logout(req, res, body) },
  { method: "POST", pattern: /^\/auth\/switch-mode$/, handler: (req, res, body) => auth.switchMode(req, res, body) },

  { method: "GET", pattern: /^\/categories$/, handler: (req) => orders.listCategories(req) },
  { method: "GET", pattern: /^\/providers\/nearby$/, handler: (req, res, body, query) => orders.nearbyProviders(req, query) },

  { method: "POST", pattern: /^\/orders$/, handler: (req, res, body) => orders.createOrder(req, res, body) },
  { method: "GET", pattern: /^\/orders$/, handler: (req, res, body, query) => orders.listOrders(req, query) },
  { method: "GET", pattern: /^\/orders\/available$/, handler: (req) => orders.availableOrders(req) },
  {
    method: "PATCH",
    pattern: /^\/providers\/me\/availability$/,
    handler: (req, res, body) => orders.updateAvailability(req, res, body),
  },
  {
    method: "PATCH",
    pattern: /^\/orders\/([^/]+)\/accept$/,
    handler: (req, res, body, query, id) => orders.acceptOrder(req, res, body, id),
  },
  {
    method: "PATCH",
    pattern: /^\/orders\/([^/]+)\/status$/,
    handler: (req, res, body, query, id) => orders.updateStatus(req, res, body, id),
  },
  {
    method: "GET",
    pattern: /^\/orders\/([^/]+)$/,
    handler: (req, res, body, query, id) => orders.getOrder(req, res, body, id),
  },
  {
    method: "POST",
    pattern: /^\/orders\/([^/]+)\/rate$/,
    handler: (req, res, body, query, id) => orders.rateOrder(req, res, body, id),
  },
  {
    method: "POST",
    pattern: /^\/providers\/me\/location$/,
    handler: (req, res, body) => orders.updateLiveLocation(req, res, body),
  },
];

const server = http.createServer(async (req, res) => {
  // CORS: مطلوب عشان تطبيق Flutter Web (شغال على Chrome من origin مختلف
  // زي localhost:xxxxx) يقدر يكلم السيرفر ده على localhost:3000. تطبيق
  // الموبايل (أندرويد/آيفون) مش محتاج الإعداد ده أصلًا لأن قيود CORS
  // بتاعة المتصفحات بس.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const query = Object.fromEntries(url.searchParams);

  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, { status: "ok", time: new Date().toISOString() });
  }

  const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
  if (!match) {
    return sendJson(res, 404, { error: "not_found", path: url.pathname });
  }

  try {
    const body = ["POST", "PATCH", "PUT"].includes(req.method) ? await readJsonBody(req) : {};
    const routeParams = match.pattern.exec(url.pathname).slice(1); // params زي :id
    const { status, data } = await match.handler(req, res, body, query, ...routeParams);
    sendJson(res, status, data);
  } catch (err) {
    const statusCode = err.statusCode || (err.message === "invalid_json" ? 400 : 500);
    if (statusCode === 500) console.error(err);
    sendJson(res, statusCode, { error: err.message || "internal_error" });
  }
});

server.listen(PORT, () => {
  console.log(`🚀 utlob-sanaii-api شغال على http://localhost:${PORT}`);
  console.log(`   جرّب: curl http://localhost:${PORT}/health`);
  console.log(`   WebSocket تتبع لحظي على ws://localhost:${PORT}/ws`);
});

// ---------------------------------------------------------------
// WebSocket: تتبع لحظي لحالة/موقع الطلب
// قناة الاشتراك: order:{orderId}:tracking
// رسالة الاشتراك من العميل: {"action":"subscribe","channel":"order:...:tracking"}
// ---------------------------------------------------------------
attachWebSocketServer(server, (conn, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get("token");

  let userId = null;
  try {
    const payload = jwt.verify(token);
    userId = payload.sub;
  } catch {
    conn.send(JSON.stringify({ type: "error", error: "invalid_token" }));
    conn.close();
    return;
  }

  let subscribedChannel = null;

  conn.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.action === "subscribe" && typeof msg.channel === "string") {
      const match = /^order:(.+):tracking$/.exec(msg.channel);
      if (!match) return;
      const orderId = match[1];

      const order = db.get("SELECT client_id, provider_id FROM orders o LEFT JOIN provider_profiles pp ON pp.id = o.provider_id WHERE o.id = ?", [orderId]);
      // التحقق: المشترك لازم يكون هو عميل الطلب أو الصنايعي بتاعه بس —
      // عشان محدش يقدر يتتبع تحركات حد تاني حتى لو خمّن الـ order_id.
      const isClient = order && order.client_id === userId;
      const isProvider = order && db.get("SELECT 1 FROM provider_profiles WHERE id = ? AND user_id = ?", [order.provider_id, userId]);

      if (!order || (!isClient && !isProvider)) {
        conn.send(JSON.stringify({ type: "error", error: "not_authorized_for_this_order" }));
        return;
      }

      subscribedChannel = msg.channel;
      hub.subscribe(subscribedChannel, conn);
      conn.send(JSON.stringify({ type: "subscribed", channel: subscribedChannel }));
    }
  });

  conn.on("close", () => {
    if (subscribedChannel) hub.unsubscribe(subscribedChannel, conn);
  });
});
