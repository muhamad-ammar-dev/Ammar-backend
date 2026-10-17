// src/utils/adminAuth.js
//
// فحص مفتاح الإدارة (X-Admin-Key) مقابل ADMIN_KEY في البيئة.
const { ADMIN_KEY } = process.env;

async function adminAuthorized(req) {
  if (!ADMIN_KEY) return false;
  const supplied = req.headers["x-admin-key"];
  return supplied && supplied === ADMIN_KEY;
}

module.exports = { adminAuthorized, adminKey: ADMIN_KEY };