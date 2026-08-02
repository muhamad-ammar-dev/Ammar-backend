// src/middleware.js
const jwt = require("./utils/jwt");

/** يقرأ ويتحقق من Authorization: Bearer التوكن، يرجع payload أو يرمي خطأ */
function requireAuth(req) {
  const header = req.headers["authorization"] || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    const err = new Error("missing_or_invalid_auth_header");
    err.statusCode = 401;
    throw err;
  }
  try {
    return jwt.verify(token);
  } catch (e) {
    const err = new Error("invalid_or_expired_token");
    err.statusCode = 401;
    throw err;
  }
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
