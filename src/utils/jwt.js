// src/utils/jwt.js
//
// تنفيذ JWT (HS256) بسيط باستخدام node:crypto بس، عشان المشروع يفضل
// بدون أي حزمة خارجية. الفورمات بالظبط زي مكتبة jsonwebtoken القياسية،
// فلو حبيت تستبدلها بـ `jsonwebtoken` في الإنتاج، التوكنات هتفضل متوافقة.

const crypto = require("node:crypto");

const SECRET = process.env.JWT_SECRET || "dev-secret-change-me-in-production";

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function sign(payload, expiresInSeconds = 3600) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + expiresInSeconds };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(body));
  const signature = crypto
    .createHmac("sha256", SECRET)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function verify(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid_token_format");
  const [encodedHeader, encodedPayload, signature] = parts;

  const expectedSignature = crypto
    .createHmac("sha256", SECRET)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  if (signature !== expectedSignature) throw new Error("invalid_signature");

  const payload = JSON.parse(Buffer.from(encodedPayload, "base64").toString("utf8"));
  if (payload.exp && Date.now() / 1000 > payload.exp) throw new Error("token_expired");

  return payload;
}

module.exports = { sign, verify };
