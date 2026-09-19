// src/notifications/fcm.js
//
// إرسال إشعارات الدفع الحقيقية عبر Firebase Cloud Messaging (FCM) —
// الإصدار HTTP v1 الجديد (واللي مبقاش في legacy "server key").
//
// المطلوب منك في Firebase Console:
//   1) Settings ⚙ → Service accounts → Generate new private key
//      → بينزّل ملف JSON فيه client_email و private_key و project_id.
//   2) متغيرات البيئة دي في السيرفر:
//        FIREBASE_PROJECT_ID      = اسم المشروع
//        FIREBASE_CLIENT_EMAIL    = client_email من الملف
//        FIREBASE_PRIVATE_KEY     = private_key من الملف (نص السطر كامل بما فيه BEGIN/END)
//      (لو عايز أسهل: FIREBASE_SERVICE_ACCOUNT_PATH = مسار ملف الـ JSON كامل)
//
// الـ private_key فيه سطور \n — لو حطيته في .env خليه سطر واحد مع \n حرفيًا
// (مثلاً: FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n").
// الكود تحت بيحوّل السطور الحرفية لأسطر حقيقية تلقائيًا.

const https = require("node:https");

const db = require("../db");
const { loadFirebaseConfig } = require("../utils/firebaseConfig");

// ---------------------------------------------------------------
// قراءة إعدادات Firebase (من src/utils/firebaseConfig.js)
// ---------------------------------------------------------------
const config = loadFirebaseConfig();
const configured = !!(config.projectId && config.clientEmail && config.privateKey);
let cachedToken = null;
let cachedTokenExpiry = 0;

// ---------------------------------------------------------------
// OAuth2 — تبادل JWT موقّع بـ RSA للحصول على access token
// ---------------------------------------------------------------
function base64Url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function signRsa256(data, privateKey) {
  const sign = require("node:crypto").createSign("RSA-SHA256");
  sign.update(data);
  return sign.sign(privateKey, "base64url");
}

function makeJwt() {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const body = {
    iss: config.clientEmail,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const h = base64Url(JSON.stringify(header));
  const b = base64Url(JSON.stringify(body));
  return `${h}.${b}.${signRsa256(`${h}.${b}`, config.privateKey)}`;
}

function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry - 300000) {
    return Promise.resolve(cachedToken);
  }
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: makeJwt(),
    });
    const req = https.request(
      {
        hostname: "oauth2.googleapis.com",
        path: "/token",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body.toString()),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(raw);
            if (res.statusCode >= 400 || !parsed.access_token) {
              return reject(new Error(`fcm_oauth_failed: ${res.statusCode} ${raw.slice(0, 300)}`));
            }
            cachedToken = parsed.access_token;
            cachedTokenExpiry = Date.now() + parsed.expires_in * 1000;
            resolve(cachedToken);
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
    req.end(body.toString());
  });
}

// ---------------------------------------------------------------
// إرسال رسالة FCM (HTTP v1: POST /v1/projects/{project}/messages:send)
// ---------------------------------------------------------------
function sendRawMessage(message) {
  if (!configured) return Promise.resolve({ skipped: "fcm_not_configured" });
  return getAccessToken()
    .then((token) => {
      return new Promise((resolve, reject) => {
        const payload = JSON.stringify({ message });
        const req = https.request(
          {
            hostname: "fcm.googleapis.com",
            path: `/v1/projects/${config.projectId}/messages:send`,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
              "Content-Length": Buffer.byteLength(payload),
            },
          },
          (res) => {
            let raw = "";
            res.on("data", (c) => (raw += c));
            res.on("end", () => {
              if (res.statusCode >= 400) {
                // 404/UNREGISTERED = التوكن ليه عمره انتهى — نحذفه من قاعدة البيانات
                if (res.statusCode === 404 || /UNREGISTERED/i.test(raw)) {
                  const t = message.token;
                  db.run("DELETE FROM device_tokens WHERE token = ?", [t]).catch(() => {});
                }
                return resolve({ error: `fcm_send_failed: ${res.statusCode} ${raw.slice(0, 300)}` });
              }
              resolve({ ok: true });
            });
          }
        );
        req.on("error", reject);
        req.end(payload);
      });
    })
    .catch((err) => ({ error: err.message }));
}

// ---------------------------------------------------------------
// API عام للـ routes
// ---------------------------------------------------------------
/// إرسال إشعار لمستخدم معيّن (كل أجهزته المسجلة)
async function sendToUser(userId, { title, body, data }) {
  if (!configured) return { skipped: "fcm_not_configured" };
  const tokens = await db.all("SELECT token FROM device_tokens WHERE user_id = ?", [userId]);
  if (!tokens.length) return { skipped: "no_tokens" };
  const results = [];
  for (const row of tokens) {
    results.push(
      await sendRawMessage({
        token: row.token,
        notification: { title, body },
        data: data || {},
        android: { priority: "high", notification: { sound: "default", channelId: "orders" } },
      })
    );
  }
  return results;
}

/// إشعار لصاحب بروفايل صنايعي معيّن (بـ provider_profile id)
async function sendToProvider(providerId, notification) {
  const provider = await db.get("SELECT user_id FROM provider_profiles WHERE id = ?", [providerId]);
  if (!provider) return { skipped: "provider_not_found" };
  return sendToUser(provider.user_id, notification);
}

/// تسجيل/تحديث توكن جهاز
async function registerToken(userId, token, platform) {
  if (!token) return { status: 400, data: { error: "token_required" } };
  await db.run(
    `INSERT INTO device_tokens (token, user_id, platform)
     VALUES (?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, platform = excluded.platform`,
    [token, userId, platform || "android"]
  );
  return { status: 200, data: { message: "token_registered" } };
}

/// حذف توكن جهاز (عند تسجيل الخروج)
async function unregisterToken(userId, token) {
  if (token) {
    // نحذف بس لو ملك المستخدم ده
    await db.run("DELETE FROM device_tokens WHERE token = ? AND user_id = ?", [token, userId]);
  } else {
    // من غير توكن = احذف كل أجهزة المستخدم
    await db.run("DELETE FROM device_tokens WHERE user_id = ?", [userId]);
  }
  return { status: 200, data: { message: "token_unregistered" } };
}

module.exports = {
  configured,
  sendToUser,
  sendToProvider,
  registerToken,
  unregisterToken,
};
