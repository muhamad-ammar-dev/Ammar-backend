// src/middleware.js
const db = require("./db");
const jwt = require("./utils/jwt");

/** يقرأ ويتحقق من Authorization: Bearer التوكن ويرجع payload — أو يرمي خطأ */
async function requireAuth(req) {
  const header = req.headers["authorization"] || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    const err = new Error("missing_or_invalid_auth_header");
    err.statusCode = 401;
    throw err;
  }
  let payload;
  try {
    payload = jwt.verify(token);
  } catch (e) {
    const err = new Error("invalid_or_expired_token");
    err.statusCode = 401;
    throw err;
  }

  // بيتأكد من حالة الحساب من قاعدة البيانات (مش التوكن بس) — لو الحساب
  // اتحذف أو اتعطّل (is_active = 0) يبطل يشتغل فورًا حتى لو التوكن لسه
  // صالح، فمحدش يقدر يستخدم الحساب بعد طلب الحذف.
  const user = await db.get("SELECT is_active FROM users WHERE id = ?", [payload.sub]);
  if (!user || !user.is_active) {
    const err = new Error("account_deactivated");
    err.statusCode = 401;
    throw err;
  }
  return payload;
}

/** يتأكد إن نوع المستخدم مسموح له يستخدم الـ endpoint ده */
function requireUserType(payload, allowedTypes) {
  if (!allowedTypes.includes(payload.user_type)) {
    const err = new Error("forbidden_for_this_user_type");
    err.statusCode = 403;
    throw err;
  }
}

module.exports = { requireAuth, requireUserType };
