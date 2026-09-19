// src/routes/devices.js
//
// تسجيل/إلغاء توكنات أجهزة الـ FCM — عشان الإشعارات الحقيقية توصل
// للصنايعي حتى لو التطبيق مقفول أو في الخلفية.

const db = require("../db");
const { requireAuth } = require("../middleware");
const fcm = require("../notifications/fcm");

// ---------------------------------------------------------------
// POST /devices/fcm — تسجيل (أو تحديث) توكن الجهاز الحالي
// body: { token, platform? }
// ---------------------------------------------------------------
async function registerDevice(req, res, body) {
  const payload = await requireAuth(req);
  const { token, platform } = body || {};
  if (!token) return { status: 400, data: { error: "token_required" } };
  return fcm.registerToken(payload.sub, token, platform);
}

// ---------------------------------------------------------------
// DELETE /devices/fcm — حذف التوكن (عند تسجيل الخروج)
// body: { token? } — لو من غير توكن بنحذف كل أجهزة المستخدم
// ---------------------------------------------------------------
async function unregisterDevice(req, res, body) {
  const payload = await requireAuth(req);
  const { token } = body || {};
  return fcm.unregisterToken(payload.sub, token);
}

// ---------------------------------------------------------------
// GET /devices/fcm — قائمة توكنات المستخدم (تشخيص/اختبار)
// ---------------------------------------------------------------
async function listDevices(req) {
  const payload = await requireAuth(req);
  const tokens = await db.all("SELECT token, platform, created_at FROM device_tokens WHERE user_id = ?", [payload.sub]);
  return { status: 200, data: { tokens } };
}

module.exports = { registerDevice, unregisterDevice, listDevices };
