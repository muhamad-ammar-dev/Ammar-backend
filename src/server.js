// src/server.js
//
// سيرفر HTTP بسيط (بدون Express) عشان المشروع يشتغل بـ Node built-ins بس.
// لو حابب تنتقل لـ Express لاحقًا، الـ route handlers في routes/*.js
// مكتوبة بشكل مستقل عن الـ HTTP layer (بتاخد body/query وترجع {status,data})
// فسهل توصلها بأي framework.

// ---------------------------------------------------------------
// تحميل .env المحلي (لو موجود) — Node مش بيقرأه لوحده. الملف ده
// مستثنى من git، فمفيش أي سر بيتسجل. على الاستضافة السحابية المتغيرات
// جاية من إعدادات الخدمة نفسها (مش من .env).
// ---------------------------------------------------------------
const fs = require("node:fs");
const path = require("node:path");
try {
  const envPath = path.join(__dirname, "..", ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
    console.log("[env] تم تحميل .env");
  }
} catch (err) {
  console.warn("[env] تعذّر تحميل .env:", err.message);
}

const http = require("node:http");
const { URL } = require("node:url");
const { sendJson, readJsonBody } = require("./utils/helpers");
const { attachWebSocketServer } = require("./ws/server");
const hub = require("./ws/hub");
const jwt = require("./utils/jwt");
const db = require("./db");

const auth = require("./routes/auth");
const orders = require("./routes/orders");
const wallet = require("./routes/wallet");
const devices = require("./routes/devices");
const fcm = require("./notifications/fcm");
const { loadFirebaseConfig } = require("./utils/firebaseConfig");

const firebaseConfig = loadFirebaseConfig();
const PORT = process.env.PORT || 3000;

// [regex, method] -> handler(req, res, body, ...params, query)
const routes = [
  { method: "POST", pattern: /^\/auth\/otp$/, handler: (req, res, body) => auth.requestOtp(req, res, body) },
  { method: "POST", pattern: /^\/auth\/verify$/, handler: (req, res, body) => auth.verifyOtp(req, res, body) },
  { method: "POST", pattern: /^\/auth\/firebase$/, handler: (req, res, body) => auth.verifyFirebaseToken(req, res, body) },
  { method: "POST", pattern: /^\/auth\/email\/otp$/, handler: (req, res, body) => auth.requestEmailOtp(req, res, body) },
  { method: "POST", pattern: /^\/auth\/email\/verify$/, handler: (req, res, body) => auth.verifyEmailOtp(req, res, body) },
  { method: "POST", pattern: /^\/auth\/refresh$/, handler: (req, res, body) => auth.refresh(req, res, body) },
  { method: "POST", pattern: /^\/auth\/logout$/, handler: (req, res, body) => auth.logout(req, res, body) },
  { method: "POST", pattern: /^\/auth\/switch-mode$/, handler: (req, res, body) => auth.switchMode(req, res, body) },
  { method: "PATCH", pattern: /^\/users\/me$/, handler: (req, res, body) => auth.updateProfile(req, res, body) },
  { method: "DELETE", pattern: /^\/users\/me$/, handler: (req, res, body) => auth.deleteAccount(req, res, body) },

  { method: "GET", pattern: /^\/categories$/, handler: (req) => orders.listCategories(req) },
  { method: "GET", pattern: /^\/providers\/nearby$/, handler: (req, res, body, query) => orders.nearbyProviders(req, query) },
  { method: "GET", pattern: /^\/providers\/me$/, handler: (req) => orders.getMyProvider(req) },
  { method: "GET", pattern: /^\/providers\/me\/custom-services$/, handler: (req) => orders.getMyCustomServices(req) },
  { method: "POST", pattern: /^\/providers\/me\/custom-services$/, handler: (req, res, body) => orders.addCustomService(req, res, body) },
  {
    method: "DELETE",
    pattern: /^\/providers\/me\/custom-services\/([^/]+)$/,
    handler: (req, res, body, query, key) => orders.deleteCustomService(req, res, body, query, key),
  },

  { method: "POST", pattern: /^\/orders$/, handler: (req, res, body) => orders.createOrder(req, res, body) },
  { method: "GET", pattern: /^\/orders$/, handler: (req, res, body, query) => orders.listOrders(req, query) },
  { method: "POST", pattern: /^\/orders\/clear-completed$/, handler: (req, res, body) => orders.clearCompletedOrders(req, res, body) },
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
    handler: (req, res, body, query, id) => orders.getOrder(req, res, body, query, id),
  },
  {
    method: "PATCH",
    pattern: /^\/orders\/([^/]+)\/price$/,
    handler: (req, res, body, query, id) => orders.setOrderPrice(req, res, body, id),
  },
  {
    method: "POST",
    pattern: /^\/orders\/([^/]+)\/rate$/,
    handler: (req, res, body, query, id) => orders.rateOrder(req, res, body, id),
  },
  {
    method: "POST",
    pattern: /^\/orders\/([^/]+)\/approve-price$/,
    handler: (req, res, body, query, id) => orders.approvePrice(req, res, body, id),
  },
  {
    method: "POST",
    pattern: /^\/orders\/([^/]+)\/reject-price$/,
    handler: (req, res, body, query, id) => orders.rejectPrice(req, res, body, id),
  },
  {
    method: "POST",
    pattern: /^\/providers\/me\/location$/,
    handler: (req, res, body) => orders.updateLiveLocation(req, res, body),
  },

  // المحفظة والعمولات
  { method: "GET", pattern: /^\/wallet$/, handler: (req) => wallet.getWallet(req) },
  { method: "POST", pattern: /^\/wallet\/transactions\/clear$/, handler: (req, res, body) => wallet.clearWalletTransactions(req, res, body) },
  { method: "POST", pattern: /^\/wallet\/commission\/pay$/, handler: (req, res, body) => wallet.payCommission(req, res, body) },
  { method: "POST", pattern: /^\/wallet\/commission\/confirm$/, handler: (req, res, body) => wallet.confirmCommission(req, res, body) },
  { method: "GET", pattern: /^\/admin\/commissions$/, handler: (req) => wallet.adminCommissions(req) },

  // إشعارات الدفع (FCM) — تسجيل أجهزة
  { method: "POST", pattern: /^\/devices\/fcm$/, handler: (req, res, body) => devices.registerDevice(req, res, body) },
  { method: "DELETE", pattern: /^\/devices\/fcm$/, handler: (req, res, body) => devices.unregisterDevice(req, res, body) },
  { method: "GET", pattern: /^\/devices\/fcm$/, handler: (req) => devices.listDevices(req) },
];

const server = http.createServer(async (req, res) => {
  // CORS: مطلوب عشان تطبيق Flutter Web (شغال على Chrome من origin مختلف
  // زي localhost:xxxxx) يقدر يكلم السيرفر ده على localhost:3000. تطبيق
  // الموبايل (أندرويد/آيفون) مش محتاج الإعداد ده أصلًا لأن قيود CORS
  // بتاعة المتصفحات بس.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Key");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const query = Object.fromEntries(url.searchParams);

  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, {
      status: "ok",
      time: new Date().toISOString(),
      fcm_configured: fcm.configured,
      firebase_project: firebaseConfig.projectId || null,
    });
  }

  const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
  if (!match) {
    return sendJson(res, 404, { error: "not_found", path: url.pathname });
  }

  try {
    const body = ["POST", "PATCH", "PUT", "DELETE"].includes(req.method) ? await readJsonBody(req) : {};
    const routeParams = match.pattern.exec(url.pathname).slice(1); // params زي :id
    const { status, data } = await match.handler(req, res, body, query, ...routeParams);
    sendJson(res, status, data);
  } catch (err) {
    const statusCode = err.statusCode || (err.message === "invalid_json" ? 400 : 500);
    if (statusCode === 500) console.error(err);
    sendJson(res, statusCode, { error: err.message || "internal_error" });
  }
});

// في وضع PostgreSQL لازم نتأكد إن الاتصال تم والـ schema جاهزة قبل ما
// نستقبل أي طلب — لو الـ DB مش متاحة نفضّل نفشل فورًا (fail fast).
db.ready
  .then(() => {
    if (db.mode === "postgres") {
      console.log(`   قاعدة البيانات: PostgreSQL (${db.mode})`);
    } else {
      console.log(`   قاعدة البيانات: SQLite (وضع التطوير) — حطّ DATABASE_URL للإنتاج`);
    }
    server.listen(PORT, () => {
      console.log(`🚀 utlob-sanaii-api شغال على http://localhost:${PORT}`);
      console.log(`   جرّب: curl http://localhost:${PORT}/health`);
      console.log(`   WebSocket تتبع لحظي على ws://localhost:${PORT}/ws`);
      const email = firebaseConfig.clientEmail || "-";
      console.log(`   [fcm] ${firebaseConfig.privateKey ? "متظبط ✅" : "مش متظبط ❌"} | project=${firebaseConfig.projectId || "-"} | email=${email}`);
    });
  })
  .catch((err) => {
    console.error("فشل تشغيل السيرفر:", err.message || err);
    process.exit(1);
  });

// ---------------------------------------------------------------
// تنظيف دوري: الحسابات اللي طلب صاحبها حذفها وعدّى عليها 30 يوم
// بتتمسح نهائيًا (تمويه البيانات) في الخلفية من غير ما نحتاج أي تفاعل.
// ---------------------------------------------------------------
const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000; // كل 6 ساعات
setInterval(async () => {
  try {
    const purged = await auth.purgeExpiredDeletions();
    console.log(`[purge] فحص الحسابات المحذوفة — تم حذف ${purged} حساب نهائيًا`);
  } catch (err) {
    console.error("[purge] خطأ في الحذف النهائي:", err.message || err);
  }
}, PURGE_INTERVAL_MS);

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

  // كل اتصال يقدر يشترك في أكتر من قناة (تتبع طلب + طلبات متاحة + توفر الصنايعية)
  const subscribedChannels = new Set();

  conn.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    try {
      if (msg.action === "subscribe" && typeof msg.channel === "string") {
        const channel = msg.channel;

        if (/^order:(.+):tracking$/.test(channel)) {
          const orderId = /^order:(.+):tracking$/.exec(channel)[1];

          const order = await db.get("SELECT client_id, provider_id FROM orders o LEFT JOIN provider_profiles pp ON pp.id = o.provider_id WHERE o.id = ?", [orderId]);
          // التحقق: المشترك لازم يكون هو عميل الطلب أو الصنايعي بتاعه بس —
          // عشان محدش يقدر يتتبع تحركات حد تاني حتى لو خمّن الـ order_id.
          const isClient = order && order.client_id === userId;
          const isProvider = order && (await db.get("SELECT 1 FROM provider_profiles WHERE id = ? AND user_id = ?", [order.provider_id, userId]));

          if (!order || (!isClient && !isProvider)) {
            conn.send(JSON.stringify({ type: "error", error: "not_authorized_for_this_order" }));
            return;
          }
        } else if (/^provider:(.+):incoming$/.test(channel)) {
          // إشعارات الطلبات الجديدة المرسلة لهذا الصنايعي تحديدًا.
          // التحقق: لازم يكون صاحب البروفايل نفسه — عشان منع التنصّت على طلبات حد تاني.
          const providerId = /^provider:(.+):incoming$/.exec(channel)[1];
          const owner = await db.get("SELECT 1 FROM provider_profiles WHERE id = ? AND user_id = ?", [providerId, userId]);
          if (!owner) {
            conn.send(JSON.stringify({ type: "error", error: "not_your_provider_channel" }));
            return;
          }
        } else if (channel === "orders:available") {
          // الطلبات المتاحة: الصنايعي بس. بنشتركه فعليًا في قناة كل تخصص
          // من تخصصاته (orders:available:cat:{id}) عشان يستقبل الطلبات
          // اللي في تخصصه بس، مش كل الطلبات من كل التخصصات.
          const provider = await db.get("SELECT * FROM provider_profiles WHERE user_id = ?", [userId]);
          if (!provider) {
            conn.send(JSON.stringify({ type: "error", error: "not_a_provider" }));
            return;
          }
          const categories = await db.all("SELECT category_id FROM provider_categories WHERE provider_id = ?", [provider.id]);
          subscribedChannels.add(channel);
          hub.subscribe(channel, conn);
          for (const cat of categories) {
            const catChannel = `orders:available:cat:${cat.category_id}`;
            subscribedChannels.add(catChannel);
            hub.subscribe(catChannel, conn);
          }
          conn.send(JSON.stringify({ type: "subscribed", channel }));
          return;
        } else if (channel === "providers:available") {
          // تغيّر توفر الصنايعية: أي مستخدم مسجّل (العميل هو المستهلك الأساسي)
        } else {
          return; // قناة مش معروفة — نتجاهل بصمت
        }

        subscribedChannels.add(channel);
        hub.subscribe(channel, conn);
        conn.send(JSON.stringify({ type: "subscribed", channel }));
      }
    } catch (err) {
      conn.send(JSON.stringify({ type: "error", error: "internal_error" }));
      console.error("[ws]", err);
    }
  });

  conn.on("close", () => {
    for (const ch of subscribedChannels) hub.unsubscribe(ch, conn);
  });
});
