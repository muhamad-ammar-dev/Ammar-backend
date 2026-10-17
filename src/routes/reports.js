// src/routes/reports.js
//
// إبلاغات/شكاوى المستخدمين: المستخدم اللي بيسجل دخوله يقدر يقدّم بلاغ.
// الأدمن يراجعها من لوحة الإدارة.

const { requireAuth } = require("../middleware");
const db = require("../db");
const { randomUUID } = require("node:crypto");
const { normalizePhone } = require("../utils/helpers");

const REPORT_TYPES = ["dispute", "fake_account", "abuse", "other"];

async function createReport(req, res, body) {
  const payload = await requireAuth(req);
  const type = String(body.type || "").trim();
  const description = String(body.description || "").trim();
  if (!REPORT_TYPES.includes(type)) return { status: 400, data: { error: "invalid_type" } };
  if (!description) return { status: 400, data: { error: "description_required" } };

  let reportedUserId = null;
  const reportedPhoneRaw = String(body.reported_phone || body.reportedPhone || "").trim();
  if (reportedPhoneRaw) {
    try {
      const normalized = normalizePhone(reportedPhoneRaw);
      const target = await db.get("SELECT id FROM users WHERE phone_number = ?", [normalized]);
      if (target) reportedUserId = target.id;
    } catch (_) {
      // لو الرقم مش في صيغة مصرية منتوقعها، نتجاهل البحث عن حساب مقترن.
    }
  }

  let orderId = body.order_id != null ? String(body.order_id).trim() : (body.orderId != null ? String(body.orderId).trim() : null);
  if (orderId === "") orderId = null;

  const id = randomUUID();
  await db.run(
    "INSERT INTO reports (id, reporter_id, reported_user_id, reported_phone, order_id, type, description, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'open')",
    [id, payload.sub, reportedUserId, reportedPhoneRaw || null, orderId, type, description]
  );
  return { status: 201, data: { message: "report_submitted", report_id: id } };
}

module.exports = { createReport };
