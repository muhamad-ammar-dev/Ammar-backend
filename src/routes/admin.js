// src/routes/admin.js
//
// نقاط إدارة الإبلاغات والمستخدمين + حظر/فك حظر. بيحكم عليها بـ X-Admin-Key.
const db = require("../db");
const { adminAuthorized } = require("../utils/adminAuth");

async function listReports(req, res, body, query) {
  if (!(await adminAuthorized(req))) return { status: 403, data: { error: "admin_unauthorized" } };
  const status = query && query.status ? String(query.status) : null;
  const sql = `
    SELECT r.id, r.reporter_id, r.reported_user_id, r.reported_phone, r.order_id, r.type, r.description, r.status, r.admin_note, r.created_at, r.resolved_at,
           ur.name AS reporter_name, ur.phone_number AS reporter_phone, ur.email AS reporter_email,
           usr.name AS reported_name, usr.phone_number AS reported_phone_user
    FROM reports r
    JOIN users ur ON ur.id = r.reporter_id
    LEFT JOIN users usr ON usr.id = r.reported_user_id
    ${status ? "WHERE r.status = ?" : ""}
    ORDER BY r.created_at DESC
  `;
  const params = status ? [status] : [];
  const rows = await db.all(sql, params);
  return { status: 200, data: { reports: rows } };
}

async function updateReport(req, res, body, query, id) {
  if (!(await adminAuthorized(req))) return { status: 403, data: { error: "admin_unauthorized" } };
  const reportId = id;
  if (!reportId) return { status: 400, data: { error: "report_id_required" } };
  const allowed = ["open", "reviewing", "resolved", "dismissed"];
  const status = String(body.status || "").trim();
  const adminNote = body.admin_note != null ? String(body.admin_note).trim() : null;
  if (status && !allowed.includes(status)) return { status: 400, data: { error: "invalid_status" } };
  const existing = await db.get("SELECT * FROM reports WHERE id = ?", [reportId]);
  if (!existing) return { status: 404, data: { error: "not_found" } };
  const newStatus = status || existing.status;
  const resolvedAt = (newStatus === "resolved" || newStatus === "dismissed") ? new Date().toISOString() : null;
  await db.run(
    "UPDATE reports SET status = ?, admin_note = COALESCE(?, admin_note), resolved_at = COALESCE(?, resolved_at) WHERE id = ?",
    [newStatus, adminNote || null, resolvedAt, reportId]
  );
  return { status: 200, data: { message: "updated" } };
}

async function listUsers(req, res, body, query) {
  if (!(await adminAuthorized(req))) return { status: 403, data: { error: "admin_unauthorized" } };
  const q = query && query.q ? String(query.q).toLowerCase() : null;
  let sql = `
    SELECT u.id, u.name, u.phone_number, u.email, u.address, u.user_type, u.is_active, u.is_banned, u.ban_reason, u.banned_at, u.created_at,
           pp.id AS provider_id,
           (SELECT COALESCE(ROUND(w.unpaid_commission, 2), 0) FROM provider_wallets w WHERE w.provider_id = pp.id) AS unpaid_commission
    FROM users u
    LEFT JOIN provider_profiles pp ON pp.user_id = u.id
  `;
  const params = [];
  if (q) {
    sql += " WHERE lower(u.name) LIKE ? OR lower(u.phone_number) LIKE ? OR lower(u.email) LIKE ? OR lower(u.address) LIKE ? OR u.id = ?";
    const like = `%${q}%`;
    params.push(like, like, like, like, q);
  }
  sql += " ORDER BY u.created_at DESC LIMIT 200";
  const users = await db.all(sql, params);
  // إضافة تخصصات لكل صنايعي
  const providerIds = users.filter(x => x.provider_id).map(x => x.provider_id);
  if (providerIds.length > 0) {
    const placeholders = providerIds.map(() => "?").join(",");
    const cats = await db.all(
      `SELECT pc.provider_id AS provider_id, c.name_ar AS name_ar
       FROM provider_categories pc
       JOIN categories c ON c.id = pc.category_id
       WHERE pc.provider_id IN (${placeholders})
       ORDER BY c.name_ar`,
      providerIds
    );
    const map = new Map();
    for (const c of cats) {
      if (!map.has(c.provider_id)) map.set(c.provider_id, []);
      map.get(c.provider_id).push(c.name_ar);
    }
    for (const u of users) {
      u.categories = u.provider_id ? (map.get(u.provider_id) || []) : [];
    }
  } else {
    for (const u of users) u.categories = [];
  }
  return { status: 200, data: { users } };
}

async function banUser(req, res, body, query, id) {
  if (!(await adminAuthorized(req))) return { status: 403, data: { error: "admin_unauthorized" } };
  const userId = id;
  if (!userId) return { status: 400, data: { error: "user_id_required" } };
  const reason = String(body.reason || "").trim();
  if (!reason) return { status: 400, data: { error: "reason_required" } };
  await db.run(
    "UPDATE users SET is_banned = 1, ban_reason = ?, banned_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [reason, userId]
  );
  return { status: 200, data: { message: "banned" } };
}

async function unbanUser(req, res, body, query, id) {
  if (!(await adminAuthorized(req))) return { status: 403, data: { error: "admin_unauthorized" } };
  const userId = id;
  if (!userId) return { status: 400, data: { error: "user_id_required" } };
  await db.run(
    "UPDATE users SET is_banned = 0, ban_reason = NULL, banned_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [userId]
  );
  return { status: 200, data: { message: "unbanned" } };
}

module.exports = { listReports, updateReport, listUsers, banUser, unbanUser };
