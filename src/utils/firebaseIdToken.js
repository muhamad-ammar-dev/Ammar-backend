// src/utils/firebaseIdToken.js
//
// التحقق من Firebase ID token يدويًا بدون أي حزمة خارجية — نفس فلسفة
// jwt.js و fcm.js في المشروع. Firebase بيصدر التوكن بصيغة JWT موقّعة
// بـ RS256، والـ public keys متاحة من:
//   https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com
//
// الخطوات:
//   1) نقسّم التوكن (header.payload.signature) ونفك الـ header.
//   2) نجيب الشهادة العامة اللي اسمها kid (من الـ header) من Google.
//   3) نتأكد من التوقيع بـ RSA-SHA256.
//   4) نتأكد من claims: iss و aud و exp و auth_time.
//
// المرجع الرسمي: https://firebase.google.com/docs/auth/admin/verify-id-tokens

const crypto = require("node:crypto");
const https = require("node:https");

const { loadFirebaseConfig } = require("./firebaseConfig");

const config = loadFirebaseConfig();
const CERT_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
const CERT_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // Google بنصح تكرش الشهادات لساعات

let cachedCerts = null;
let cachedAt = 0;

function base64UrlToBuffer(str) {
  // فك ترميز base64url يدويًا لأن Buffer.from(str, "base64") مش بيفهم - و _
  const normalized = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4;
  const padded = pad === 2 ? normalized + "==" : pad === 3 ? normalized + "=" : normalized;
  return Buffer.from(padded, "base64");
}

function fetchCerts() {
  return new Promise((resolve, reject) => {
    const req = https.get(
      CERT_URL,
      { headers: { Accept: "application/json" } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`certs_fetch_failed: ${res.statusCode}`));
          }
          try {
            const certs = JSON.parse(raw);
            cachedCerts = certs;
            cachedAt = Date.now();
            resolve(certs);
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
  });
}

async function getCert(kid) {
  // أول مرة أو بعد انتهاء TTL — نجيب الشهادات من Google ونكرشها
  if (!cachedCerts || Date.now() - cachedAt > CERT_CACHE_TTL_MS) {
    await fetchCerts();
  }
  if (cachedCerts && !cachedCerts[kid]) {
    // ممكن يكون حصل rotation للـ keys — نعمل refetch مرة واحدة
    await fetchCerts();
  }
  return cachedCerts && cachedCerts[kid];
}

/**
 * يتحقق من Firebase ID token ويرجّع الـ claims (payload).
 * بيرمي Error لو التوكن مش صالح.
 */
async function verifyIdToken(idToken) {
  if (!config.projectId) {
    throw new Error("firebase_not_configured");
  }
  if (!idToken || typeof idToken !== "string") {
    throw new Error("invalid_token_format");
  }

  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("invalid_token_format");

  const [headerB64, payloadB64, signatureB64] = parts;

  let header, payload;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid_token_encoding");
  }

  if (header.alg !== "RS256") throw new Error("invalid_algorithm");
  if (!payload || typeof payload !== "object") throw new Error("invalid_claims");

  // فحص claims الأساسية
  const nowSec = Math.floor(Date.now() / 1000);
  const CLOCK_SKEW_SEC = 60;

  if (payload.iss !== `https://securetoken.google.com/${config.projectId}`) {
    throw new Error("wrong_issuer");
  }
  if (payload.aud !== config.projectId) {
    throw new Error("wrong_audience");
  }
  if (typeof payload.exp !== "number" || payload.exp < nowSec - CLOCK_SKEW_SEC) {
    throw new Error("token_expired");
  }
  if (
    typeof payload.auth_time === "number" &&
    payload.auth_time > nowSec + CLOCK_SKEW_SEC
  ) {
    throw new Error("token_used_before_issued");
  }
  if (!payload.sub) throw new Error("missing_subject");

  // التحقق من التوقيع بالشهادة العامة المقابلة للـ kid
  const cert = await getCert(header.kid);
  if (!cert) throw new Error("unknown_signing_key");

  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = base64UrlToBuffer(signatureB64);

  const publicKey = crypto.createPublicKey(cert);
  const valid = crypto.verify(
    "RSA-SHA256",
    Buffer.from(signingInput, "utf8"),
    publicKey,
    signature
  );
  if (!valid) throw new Error("invalid_signature");

  return payload;
}

module.exports = { verifyIdToken };
