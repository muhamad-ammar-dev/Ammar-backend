// src/routes/orders.js
//
// تنفيذ مبسّط مطابق لملف orders-endpoints.md — كافي تختبر بيه الفلو الكامل
// محليًا. في الإنتاج (Postgres) استبدل حساب المسافة بـ PostGIS أو Redis GEO
// زي ما اتفقنا في tracking-realtime.md، بدل حسابها في JS زي هنا.

const db = require("../db");
const { requireAuth, requireUserType } = require("../middleware");
const { uuid } = require("../utils/helpers");

const VALID_TRANSITIONS = {
  pending: ["accepted", "cancelled"],
  accepted: ["on_way", "cancelled"],
  on_way: ["arrived"],
  arrived: ["in_progress"],
  in_progress: ["completed"],
  completed: [],
  cancelled: [],
};

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------
// GET /categories
// ---------------------------------------------------------------
async function listCategories(req) {
  const categories = db.all("SELECT id, name_ar, icon FROM categories");
  return { status: 200, data: { categories } };
}

// ---------------------------------------------------------------
// GET /providers/nearby?category_id=&lat=&lng=&radius_km=
// ---------------------------------------------------------------
async function nearbyProviders(req, query) {
  requireAuth(req);
  const categoryId = Number(query.category_id);
  const lat = Number(query.lat);
  const lng = Number(query.lng);
  const radiusKm = Number(query.radius_km) || 10;

  if (!categoryId || Number.isNaN(lat) || Number.isNaN(lng)) {
    return { status: 400, data: { error: "category_id_lat_lng_required" } };
  }

  const rows = db.all(
    `SELECT pp.*, u.name, u.id AS user_id
     FROM provider_profiles pp
     JOIN users u ON u.id = pp.user_id
     JOIN provider_categories pc ON pc.provider_id = pp.id
     WHERE pc.category_id = ? AND pp.is_available = 1 AND pp.current_lat IS NOT NULL`,
    [categoryId]
  );

  const nearby = rows
    .map((p) => ({ ...p, distance_km: haversineKm(lat, lng, p.current_lat, p.current_lng) }))
    .filter((p) => p.distance_km <= radiusKm)
    .sort((a, b) => b.rating_avg - a.rating_avg || a.distance_km - b.distance_km)
    .slice(0, 20)
    .map((p) => ({
      id: p.id,
      name: p.name,
      rating_avg: p.rating_avg,
      jobs_completed: p.jobs_completed,
      distance_km: Math.round(p.distance_km * 10) / 10,
      eta_minutes: Math.max(3, Math.round(p.distance_km * 3)), // تقدير تقريبي بسيط
    }));

  return { status: 200, data: { providers: nearby } };
}

// ---------------------------------------------------------------
// POST /orders
// ---------------------------------------------------------------
async function createOrder(req, res, body) {
  const payload = requireAuth(req);
  const { category_id, address_text, lat, lng, notes } = body;

  if (!category_id || !address_text || lat == null || lng == null) {
    return { status: 400, data: { error: "category_id_address_lat_lng_required" } };
  }

  const id = uuid();
  db.run(
    `INSERT INTO orders (id, client_id, category_id, status, address_text, lat, lng, notes)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
    [id, payload.sub, category_id, address_text, lat, lng, notes || null]
  );
  db.run("INSERT INTO order_status_log (order_id, status, changed_by) VALUES (?, 'pending', ?)", [id, payload.sub]);

  // TODO (إنتاج): هنا بيتم بث إشعار (FCM) للصنايعية القريبين المتاحين في نفس التخصص.

  const order = db.get("SELECT * FROM orders WHERE id = ?", [id]);
  return { status: 201, data: order };
}

// ---------------------------------------------------------------
// PATCH /orders/:id/accept
// ---------------------------------------------------------------
async function acceptOrder(req, res, body, orderId) {
  const payload = requireAuth(req);
  requireUserType(payload, ["provider", "both"]);

  const provider = db.get("SELECT * FROM provider_profiles WHERE user_id = ?", [payload.sub]);
  if (!provider) return { status: 403, data: { error: "not_a_provider" } };

  // UPDATE شرطي atomic — يمنع أكتر من صنايعي ياخدوا نفس الطلب (race condition)
  const result = db.run(
    `UPDATE orders SET provider_id = ?, status = 'accepted', accepted_at = datetime('now')
     WHERE id = ? AND status = 'pending'`,
    [provider.id, orderId]
  );

  if (result.changes === 0) {
    return { status: 409, data: { error: "order_already_taken" } };
  }

  db.run("INSERT INTO order_status_log (order_id, status, changed_by) VALUES (?, 'accepted', ?)", [
    orderId,
    payload.sub,
  ]);

  const order = db.get("SELECT * FROM orders WHERE id = ?", [orderId]);
  return { status: 200, data: order };
}

// ---------------------------------------------------------------
// PATCH /orders/:id/status
// ---------------------------------------------------------------
async function updateStatus(req, res, body, orderId) {
  const payload = requireAuth(req);
  const { status: newStatus, cancel_reason } = body;

  const order = db.get("SELECT * FROM orders WHERE id = ?", [orderId]);
  if (!order) return { status: 404, data: { error: "order_not_found" } };

  const allowed = VALID_TRANSITIONS[order.status] || [];
  if (!allowed.includes(newStatus)) {
    return {
      status: 400,
      data: { error: "invalid_status_transition", current_status: order.status, requested_status: newStatus },
    };
  }

  if (newStatus === "cancelled" && !cancel_reason) {
    return { status: 400, data: { error: "cancel_reason_required" } };
  }

  if (newStatus === "completed") {
    db.run("UPDATE orders SET status = ?, completed_at = datetime('now') WHERE id = ?", [newStatus, orderId]);
  } else if (newStatus === "cancelled") {
    db.run("UPDATE orders SET status = ?, cancelled_at = datetime('now'), cancel_reason = ? WHERE id = ?", [
      newStatus,
      cancel_reason,
      orderId,
    ]);
  } else {
    db.run("UPDATE orders SET status = ? WHERE id = ?", [newStatus, orderId]);
  }

  if (newStatus === "completed" && order.provider_id) {
    db.run("UPDATE provider_profiles SET jobs_completed = jobs_completed + 1 WHERE id = ?", [order.provider_id]);
  }

  db.run("INSERT INTO order_status_log (order_id, status, changed_by) VALUES (?, ?, ?)", [
    orderId,
    newStatus,
    payload.sub,
  ]);

  const updated = db.get("SELECT * FROM orders WHERE id = ?", [orderId]);
  return { status: 200, data: updated };
}

// ---------------------------------------------------------------
// GET /orders/:id
// ---------------------------------------------------------------
async function getOrder(req, res, body, orderId) {
  requireAuth(req);
  const order = db.get("SELECT * FROM orders WHERE id = ?", [orderId]);
  if (!order) return { status: 404, data: { error: "order_not_found" } };
  return { status: 200, data: order };
}

// ---------------------------------------------------------------
// GET /orders?role=client|provider&status=
// ---------------------------------------------------------------
async function listOrders(req, query) {
  const payload = requireAuth(req);
  const { role = "client", status } = query;

  let sql, params;
  if (role === "provider") {
    const provider = db.get("SELECT * FROM provider_profiles WHERE user_id = ?", [payload.sub]);
    if (!provider) return { status: 200, data: { orders: [] } };
    sql = "SELECT * FROM orders WHERE provider_id = ?";
    params = [provider.id];
  } else {
    sql = "SELECT * FROM orders WHERE client_id = ?";
    params = [payload.sub];
  }

  if (status) {
    sql += " AND status = ?";
    params.push(status);
  }
  sql += " ORDER BY created_at DESC LIMIT 50";

  const orders = db.all(sql, params);
  return { status: 200, data: { orders, total: orders.length } };
}

// ---------------------------------------------------------------
// GET /orders/available — الطلبات المعلّقة في تخصصات الصنايعي الحالي
// ---------------------------------------------------------------
async function availableOrders(req) {
  const payload = requireAuth(req);
  requireUserType(payload, ["provider", "both"]);

  const provider = db.get("SELECT * FROM provider_profiles WHERE user_id = ?", [payload.sub]);
  if (!provider) return { status: 403, data: { error: "not_a_provider" } };

  const orders = db.all(
    `SELECT o.*, u.name AS client_name
     FROM orders o
     JOIN users u ON u.id = o.client_id
     WHERE o.status = 'pending'
       AND o.category_id IN (
         SELECT category_id FROM provider_categories WHERE provider_id = ?
       )
     ORDER BY o.created_at DESC
     LIMIT 20`,
    [provider.id]
  );

  return { status: 200, data: { orders } };
}

// ---------------------------------------------------------------
// PATCH /providers/me/availability — تفعيل/إلغاء "متاح الآن" + الموقع + التخصصات
// ---------------------------------------------------------------
async function updateAvailability(req, res, body) {
  const payload = requireAuth(req);
  requireUserType(payload, ["provider", "both"]);

  const provider = db.get("SELECT * FROM provider_profiles WHERE user_id = ?", [payload.sub]);
  if (!provider) return { status: 403, data: { error: "not_a_provider" } };

  const { is_available, lat, lng, category_ids } = body;

  db.run(
    `UPDATE provider_profiles
     SET is_available = ?, current_lat = COALESCE(?, current_lat), current_lng = COALESCE(?, current_lng),
         location_updated_at = datetime('now')
     WHERE id = ?`,
    [is_available ? 1 : 0, lat ?? null, lng ?? null, provider.id]
  );

  if (Array.isArray(category_ids)) {
    db.run("DELETE FROM provider_categories WHERE provider_id = ?", [provider.id]);
    const insertCat = "INSERT INTO provider_categories (provider_id, category_id) VALUES (?, ?)";
    for (const categoryId of category_ids) {
      db.run(insertCat, [provider.id, categoryId]);
    }
  }

  const updated = db.get("SELECT * FROM provider_profiles WHERE id = ?", [provider.id]);
  return { status: 200, data: updated };
}

module.exports = {
  listCategories,
  nearbyProviders,
  createOrder,
  acceptOrder,
  updateStatus,
  getOrder,
  listOrders,
  availableOrders,
  updateAvailability,
};
