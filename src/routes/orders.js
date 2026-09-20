// src/routes/orders.js
//
// تنفيذ مبسّط مطابق لملف orders-endpoints.md — كافي تختبر بيه الفلو الكامل
// محليًا. في الإنتاج (Postgres) استبدل حساب المسافة بـ PostGIS أو Redis GEO
// زي ما اتفقنا في tracking-realtime.md، بدل حسابها في JS زي هنا.

const db = require("../db");
const { requireAuth, requireUserType } = require("../middleware");
const { uuid } = require("../utils/helpers");
const hub = require("../ws/hub");
const walletService = require("../wallet");
const fcm = require("../notifications/fcm");
const { getSchemaByCategoryName } = require("../pricing");

const VALID_TRANSITIONS = {
  pending: ["accepted", "cancelled"],
  accepted: ["on_way", "cancelled"],
  on_way: ["arrived"],
  arrived: ["in_progress"],
  in_progress: ["completed"],
  price_pending: ["completed", "in_progress"],
  completed: [],
  cancelled: [],
};

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

// قراءة JSON مخزّن في عمود TEXT بشكل آمن (يرجع null لو بايظ)
function safeParseJson(str) {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch (_) {
    return null;
  }
}

// التحقق من أسعار الصنايعي مقابل مخطط المهنة: كل بند إجباري ورقم ≥ 0.
// بترجع { ok: true, rates } أو { ok: false, error }
function validatePricingData(schema, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "pricing_data_required" };
  }
  const rates = {};
  for (const item of schema.items) {
    const v = Number(input[item.key]);
    if (input[item.key] === undefined || input[item.key] === null || input[item.key] === "") {
      return { ok: false, error: `pricing_rate_required:${item.key}` };
    }
    if (!Number.isFinite(v) || v < 0) {
      return { ok: false, error: `pricing_rate_invalid:${item.key}` };
    }
    rates[item.key] = round2(v);
  }
  return { ok: true, rates };
}

// جلب مهنة الصنايعي الواحدة مع مخطط الأسعار بتاعها
async function getProviderCategoryWithSchema(providerId) {
  const row = await db.get(
    `SELECT c.id AS category_id, c.name_ar, c.icon
     FROM provider_categories pc JOIN categories c ON c.id = pc.category_id
     WHERE pc.provider_id = ? LIMIT 1`,
    [providerId]
  );
  if (!row) return null;
  const schema = getSchemaByCategoryName(row.name_ar);
  return schema ? { ...row, schema } : null;
}

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
// GET /categories — مع بنود تسعير كل مهنة (pricing_items) عشان
// شاشتين التطبيق (أسعار الصنايعي + تفاصيل طلب العميل) يتبنوا ديناميكيًا.
// ---------------------------------------------------------------
async function listCategories(req) {
  const categories = await db.all("SELECT id, name_ar, icon FROM categories");
  const data = categories.map((c) => {
    const schema = getSchemaByCategoryName(c.name_ar);
    return { ...c, pricing_items: schema ? schema.items : null };
  });
  return { status: 200, data: { categories: data } };
}

// ---------------------------------------------------------------
// GET /providers/nearby?category_id=&lat=&lng=&radius_km=
// ---------------------------------------------------------------
async function nearbyProviders(req, query) {
  await requireAuth(req);
  const categoryId = Number(query.category_id);
  const lat = Number(query.lat);
  const lng = Number(query.lng);
  const radiusKm = Number(query.radius_km) || 20;

  if (!categoryId || Number.isNaN(lat) || Number.isNaN(lng)) {
    return { status: 400, data: { error: "category_id_lat_lng_required" } };
  }

  const rows = await db.all(
    `SELECT pp.*, u.name, u.id AS user_id
     FROM provider_profiles pp
     JOIN users u ON u.id = pp.user_id
     JOIN provider_categories pc ON pc.provider_id = pp.id
     WHERE pc.category_id = ? AND pp.is_available = 1 AND pp.current_lat IS NOT NULL AND u.is_active = 1`,
    [categoryId]
  );

  const nearby = rows
    .map((p) => ({ ...p, distance_km: haversineKm(lat, lng, p.current_lat, p.current_lng) }))
    .filter((p) => p.distance_km <= radiusKm)
    .sort((a, b) => b.rating_avg - a.rating_avg || a.distance_km - b.distance_km)
    .slice(0, 20)
    .map((p) => ({
      id: p.id,
      // الخصوصية: رقم تليفون الصنايعي مبيتبعتش للعميل خالص — العميل
      // يشوف اسمه بس، ولو مسح اسمه نعرض "مستخدم" بدل ما نعرض رقمه.
      name: p.name || "مستخدم",
      rating_avg: p.rating_avg,
      jobs_completed: p.jobs_completed,
      hourly_rate: p.hourly_rate,
      // أسعاره الخاصة بمهنته (بنود من src/pricing.js) — التطبيق بيحسب
      // منه سعر الطلب التقديري على طول
      pricing_data: safeParseJson(p.pricing_data),
      distance_km: Math.round(p.distance_km * 10) / 10,
      eta_minutes: Math.max(3, Math.round(p.distance_km * 3)), // تقدير تقريبي بسيط
    }));
  // الخدمات الإضافية المخصصة لكل صنايعي (بيضيفها بنفسه) — بنقراها هنا
  // بإجراء واحد لكل provider موجود في القايمة النهائية.
  for (const p of nearby) {
    p.custom_services = await db.all(
      "SELECT key, name_ar, unit_ar, price FROM provider_custom_services WHERE provider_id = ?",
      [p.id]
    );
  }

  return { status: 200, data: { providers: nearby } };
}

// ---------------------------------------------------------------
// POST /orders
// السعر بيتحدد حسب مخطط المهنة: العميل بيبعت order_details فيه كمية
// كل بند (مثال: محارة داخلية 40 متر²، خارجية 60 متر²) والسعر بيتحسب
// من أسعار الصنايعي المسجلة في مهنته. لو مفيش مخطط للمهنة، بنرجع
// للفلو القديم (ساعات أ— أجر الساعة) للتوافق مع الطلبات القديمة.
// ---------------------------------------------------------------
async function createOrder(req, res, body) {
  const payload = await requireAuth(req);
  const { category_id, address_text, lat, lng, notes, images, provider_id } = body;

  if (!category_id || !address_text || lat == null || lng == null) {
    return { status: 400, data: { error: "category_id_address_lat_lng_required" } };
  }

  if (!provider_id) return { status: 400, data: { error: "provider_id_required" } };

  const provider = await db.get("SELECT * FROM provider_profiles WHERE id = ?", [provider_id]);
  if (!provider) return { status: 404, data: { error: "provider_not_found" } };

  const pcRow = await getProviderCategoryWithSchema(provider_id);
  const schema = pcRow ? pcRow.schema : null;

  let price;
  let hoursNum = null;
  let hourlyRate = null;
  let detailsJson = null;
  let normalizedDetails = null;
  let customServices = [];

  if (schema) {
    // الفلو الجديد: كميات البنود إجبارية من العميل
    const input = body.order_details;
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return { status: 400, data: { error: "order_details_required" } };
    }
    const rates = safeParseJson(provider.pricing_data);
    if (!rates) {
      return { status: 400, data: { error: "provider_pricing_not_configured" } };
    }

    let total = 0;
    normalizedDetails = {};
    for (const item of schema.items) {
      const q = Number(input[item.key]);
      if (input[item.key] === undefined || input[item.key] === null || input[item.key] === "") {
        return { status: 400, data: { error: `quantity_required:${item.key}` } };
      }
      if (!Number.isFinite(q) || q < 0) {
        return { status: 400, data: { error: `quantity_invalid:${item.key}` }};
      }
      const r = Number(rates[item.key]);
      if (!Number.isFinite(r) || r < 0) {
        return { status: 400, data: { error: `provider_rate_missing:${item.key}` } };
      }
      normalizedDetails[item.key] = round2(q);
      total += q * r;
    }
    // الخدمات الإضافية المخصصة (اختيارية): لو العميل بعت كمية لبند
    // custom_N، بنضيفها على التكلفة وبنحفظها في التفاصيل.
    customServices = await listCustomServices(provider_id);
    for (const cs of customServices) {
      const q = Number(input[cs.key]);
      if (input[cs.key] === undefined || input[cs.key] === null || input[cs.key] === "" || !(q > 0)) continue;
      const crate = Number(rates[cs.key]);
      if (!Number.isFinite(crate) || crate < 0) continue;
      normalizedDetails[cs.key] = round2(q);
      total += q * crate;
    }
    if (!(total > 0)) {
      return { status: 400, data: { error: "at_least_one_item_with_quantity" } };
    }
    price = round2(total);
    detailsJson = JSON.stringify(normalizedDetails);
  } else {
    // الفلو القديم: ساعات أ— أجر الساعة
    hoursNum = Number(body.hours);
    if (!hoursNum || !Number.isFinite(hoursNum) || hoursNum <= 0) {
      return { status: 400, data: { error: "hours_must_be_positive" } };
    }
    hourlyRate = Number(provider.hourly_rate);
    if (!hourlyRate || hourlyRate <= 0) {
      return { status: 400, data: { error: "provider_hourly_rate_required" } };
    }
    price = round2(hoursNum * hourlyRate);
  }

  if (images && (!Array.isArray(images) || images.length > 3)) {
    return { status: 400, data: { error: "images_must_be_array_of_max_3" } };
  }

  const id = uuid();
  await db.run(
    `INSERT INTO orders (id, client_id, provider_id, category_id, status, address_text, lat, lng, notes, hours, hourly_rate, price, price_estimated, order_details)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, payload.sub, provider_id, category_id, address_text, lat, lng, notes || null, hoursNum, hourlyRate, price, price, detailsJson]
  );
  await db.run("INSERT INTO order_status_log (order_id, status, changed_by) VALUES (?, 'pending', ?)", [id, payload.sub]);

  if (images && images.length > 0) {
    const storage = require("../utils/storage");
    for (const img of images) {
      if (typeof img !== "string" || !img) continue;
      // الإنتاج: بنرفع الصورة على Supabase Storage ونخزّن الرابط بس في
      // القاعدة — القاعدة تفضل خفيفة وتستحمل آلاف الطلبات، والصور
      // بتتوزع من CDN سريع. لو التخزين مش متظبط (تطوير محلي) بنرجع
      // للتخزين النصي القديم بحجم محدود.
      const uploaded = await storage.uploadDataUrl(img, "orders");
      const value = uploaded || (img.length < 3_000_000 ? img : null);
      if (value) {
        await db.run(
          "INSERT INTO order_images (id, order_id, image_base64) VALUES (?, ?, ?)",
          [uuid(), id, value]
        );
      }
    }
  }

  // إشعار فوري للصنايعي المستهدف (WebSocket): أول ما الطلب بيتعمل،
  // لو التطبيق بتاعه مفتوح بيدخل إشعار على طول. ولو التطبيق مقفول أو
  // في الخلفية، بيوصله push حقيقي عبر FCM (لو متظبط) — الاتنين متوازيين.
  const order = await db.get("SELECT * FROM orders WHERE id = ?", [id]);
  const imageCount = (await db.get("SELECT COUNT(*) AS c FROM order_images WHERE order_id = ?", [id])).c;
  const client = await db.get("SELECT name, phone_number FROM users WHERE id = ?", [payload.sub]);

  // ملخص الكميات بصيغة مقروءة للإشعارات: "محارة داخلية: 40 متر²، ..."
  let detailsText = null;
  if (schema && normalizedDetails) {
    const parts = schema.items
      .filter((i) => (normalizedDetails[i.key] || 0) > 0)
      .map((i) => `${i.label_ar}: ${normalizedDetails[i.key]} ${i.unit_ar}`);
    // الخدمات الإضافية المخصصة (لو فيها كميات)
    for (const cs of customServices) {
      const q = Number(normalizedDetails[cs.key]) || 0;
      if (q > 0) parts.push(`${cs.name_ar}: ${q} ${cs.unit_ar || ""}`.trim());
    }
    detailsText = parts.join("، ");
  }

  hub.publish(`provider:${provider_id}:incoming`, {
    type: "new_order",
    order: {
      id,
      client_name: client?.name || client?.phone_number || "عميل",
      category_id,
      address_text,
      lat,
      lng,
      notes: notes || null,
      hours: hoursNum,
      hourly_rate: hourlyRate,
      price,
      order_details: normalizedDetails,
      details_text: detailsText,
      image_count: imageCount,
      created_at: order.created_at,
    },
  });

  // Push حقيقي عبر FCM — بيشتغل متوازي ومش بيعطّل استجابة إنشاء الطلب
  // حتى لو FCM مش متظبط (النتيجة بتتجاهل بصمت).
  try {
    const categoryName = (await db.get("SELECT name_ar FROM categories WHERE id = ?", [category_id]))?.name_ar || "";
    const notifResult = await fcm.sendToProvider(provider_id, {
      title: "🔔 طلب جديد",
      body: `${client?.name || client?.phone_number || "عميل"} طلب ${categoryName}${detailsText ? ` — ${detailsText}` : ""} — ${address_text}`,
      data: { type: "new_order", order_id: id },
    });
    // اقتفاء أثر للإشعارات: في لوج Render هنشوف بالظبط ليه مفيش إشعار
    // وصل (مش متظبط / مفيش توكن / خطأ FCM) عشان النشر والتعامل أسهل.
    console.log(`[fcm] new_order provider=${provider_id} order=${id} => ${JSON.stringify(notifResult)}`);
  } catch (err) {
    console.warn("[fcm] تعذّر إرسال الإشعار:", err.message);
  }

  return { status: 201, data: { ...order, image_count: imageCount } };
}

// ---------------------------------------------------------------
// PATCH /orders/:id/accept — لحظة القبول: السعر بيتثبت والأرباح +
// العمولة بتتسجل في المحفظة فورًا (فلوس الصنايعي مضمونة)، وبعدها
// الطلب يفضل في مراحله الطبيعية (accepted → on_way → ... → completed).
// ---------------------------------------------------------------
async function acceptOrder(req, res, body, orderId) {
  const payload = await requireAuth(req);
  requireUserType(payload, ["provider", "both"]);

  const provider = await db.get("SELECT * FROM provider_profiles WHERE user_id = ?", [payload.sub]);
  if (!provider) return { status: 403, data: { error: "not_a_provider" } };

  const order = await db.get("SELECT * FROM orders WHERE id = ?", [orderId]);
  if (!order) return { status: 404, data: { error: "order_not_found" } };

  // منع قبول طلبات جديدة لو عليه عمولة مستحقة وصلت للحد
  const block = await walletService.getBlockStatus(provider.id);
  if (block.blocked) {
    return {
      status: 403,
      data: { error: "commission_unpaid", unpaid_commission: block.unpaid_commission, threshold: block.threshold },
    };
  }

  // الطلب ممكن يكون مربوط بصنايعي معين (العميل اختاره) أو مفتوح لأي صنايعي
  const isAssigned = order.provider_id != null;
  if (isAssigned && order.provider_id !== provider.id) {
    return { status: 403, data: { error: "not_assigned_provider" } };
  }
  if (order.status !== "pending") {
    return { status: 409, data: { error: "order_already_taken" } };
  }
  const price = Number(order.price);
  if (!price || price <= 0) {
    return { status: 400, data: { error: "price_required_before_completion" } };
  }

  // UPDATE atomic — يمنع صنايعي تاني ياخد نفس الطلب (race condition)
  const result = await db.run(
    isAssigned
      ? `UPDATE orders SET provider_id = ?, status = 'accepted', accepted_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'pending' AND provider_id = ?`
      : `UPDATE orders SET provider_id = ?, status = 'accepted', accepted_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'pending' AND provider_id IS NULL`,
    isAssigned ? [provider.id, orderId, provider.id] : [provider.id, orderId]
  );

  if (result.changes === 0) {
    return { status: 409, data: { error: "order_already_taken" } };
  }

  // اللحظة دي السعر بيتحسب ويتثبت، والأرباح والعمولة بتتسجل في محفظة
  // الصنايعي فورًا — يعني فلوسه مضمونة من غير ما ينتظر التسليم ولا
  // موافقة سعر. بعدها بيمشي في مراحل الشغل (accepted → on_way → ...)
  // لمجرد التتبع، و"completed" في الآخر بتختم الشغلانة.
  // لو الصنايعي كان فتح الطلب قبل كده واتحسبت عليه عمولة الفتح، هنا
  // بنسجّل الإيراد بس من غير ما نصيف العمولة تاني (مرة واحدة لكل طلب).
  if (order.commission_charged_at != null) {
    await walletService.recordOrderEarnings({ ...order, provider_id: provider.id, price });
  } else {
    const walletResult = await walletService.recordCompletedOrder({ ...order, provider_id: provider.id, price });
    if (walletResult) {
      await db.run(
        "UPDATE orders SET commission_charged_at = CURRENT_TIMESTAMP, commission_percent = ?, commission_amount = ? WHERE id = ?",
        [await walletService.getCommissionPercent(), walletResult.commission, orderId]
      );
    }
  }

  await db.run("INSERT INTO order_status_log (order_id, status, changed_by) VALUES (?, 'accepted', ?)", [
    orderId,
    payload.sub,
  ]);
  hub.publish(`order:${orderId}:tracking`, { type: "status", status: "accepted", price });

  const updated = await db.get("SELECT * FROM orders WHERE id = ?", [orderId]);
  return { status: 200, data: updated };
}

// ---------------------------------------------------------------
// PATCH /orders/:id/price — الصنايعي بيحدد/يعدّل سعر الشغلانة قبل التسليم
// ---------------------------------------------------------------
async function setOrderPrice(req, res, body, orderId) {
  const payload = await requireAuth(req);
  requireUserType(payload, ["provider", "both"]);

  const order = await db.get("SELECT * FROM orders WHERE id = ?", [orderId]);
  if (!order) return { status: 404, data: { error: "order_not_found" } };

  // الصنايعي المعيّن بس هو اللي يقدر يحدد السعر، وقبل الاكتمال فقط
  if (!order.provider_id) return { status: 400, data: { error: "order_not_accepted_yet" } };
  const provider = await db.get("SELECT * FROM provider_profiles WHERE user_id = ?", [payload.sub]);
  if (!provider || provider.id !== order.provider_id) {
    return { status: 403, data: { error: "not_assigned_provider" } };
  }
  if (order.status === "completed" || order.status === "cancelled") {
    return { status: 400, data: { error: "order_already_finished" } };
  }

  const price = Number(body.price);
  if (!price || price <= 0) return { status: 400, data: { error: "price_must_be_positive" } };

  const percent = await walletService.getCommissionPercent();
  const commission = Math.round(price * percent) / 100;
  await db.run(
    "UPDATE orders SET price = ?, commission_percent = ?, commission_amount = ? WHERE id = ?",
    [price, percent, commission, orderId]
  );

  hub.publish(`order:${orderId}:tracking`, { type: "price", price, commission_percent: percent, commission_amount: commission });

  return { status: 200, data: await db.get("SELECT * FROM orders WHERE id = ?", [orderId]) };
}

// ---------------------------------------------------------------
// PATCH /orders/:id/status
// ---------------------------------------------------------------
async function updateStatus(req, res, body, orderId) {
  const payload = await requireAuth(req);
  const { status: newStatus, cancel_reason } = body;

  const order = await db.get("SELECT * FROM orders WHERE id = ?", [orderId]);
  if (!order) return { status: 404, data: { error: "order_not_found" } };

  // القبول له endpoint مخصص (accept) بيعمل atomic update ويمنع التعارض؛
  // منمنعش تحديث الحالة ده يستخدم لتخطيه.
  if (newStatus === "accepted") {
    return { status: 400, data: { error: "use_accept_endpoint_instead" } };
  }

  // فحص الصلاحية: العميل يقدر يلغي بس، والصنايعي المعيّن فعليًا للطلب
  // هو بس اللي يقدر يحدّث باقي الحالات. أي مستخدم تاني ممنوع.
  const assignedProvider = order.provider_id
    ? await db.get("SELECT * FROM provider_profiles WHERE id = ?", [order.provider_id])
    : null;
  const isClient = payload.sub === order.client_id;
  const isAssignedProvider = assignedProvider && payload.sub === assignedProvider.user_id;

  if (newStatus === "cancelled") {
    if (!isClient && !isAssignedProvider) {
      return { status: 403, data: { error: "not_authorized_for_this_order" } };
    }
  } else if (!isAssignedProvider) {
    return { status: 403, data: { error: "not_authorized_for_this_order" } };
  }

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
    // السعر كان ثابت ومثبت من لحظة القبول — هنا بس بينتهي الشغلانة.
    const price = Number(order.price);
    if (!price || !Number.isFinite(price) || price <= 0) {
      return { status: 400, data: { error: "price_required_before_completion" } };
    }

    await db.run("UPDATE orders SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?", [orderId]);

    if (order.provider_id) {
      await db.run("UPDATE provider_profiles SET jobs_completed = jobs_completed + 1 WHERE id = ?", [order.provider_id]);
    }

    // الأرباح والعمولة بيتسجلوا لحظة القبول، فمبنعيدش التسجيل هنا.
    // بس لو طلب قديم كان في 'in_progress' من غير أي تسجيل (من قبل
    // التغيير)، بنسجل هنا عشان مش يضيع عليه.
    // ملحوظة: بنعتمد على علامة commission_charged_at على الطلب نفسه
    // (مش على سجل حركات المحفظة) عشان تحدد إذا كان اتسجل — لأن الصنايعي
    // ممكن يمسح سجل الحركات من المحفظة، ومسح السجل مينفعش يخلي الطلب
    // يتمحسب عليه عمولة تاني.
    if (order.commission_charged_at == null && order.provider_id) {
      const result = await walletService.recordCompletedOrder(order);
      if (result) {
        await db.run(
          "UPDATE orders SET commission_charged_at = CURRENT_TIMESTAMP, commission_percent = ?, commission_amount = ? WHERE id = ?",
          [await walletService.getCommissionPercent(), result.commission, orderId]
        );
      }
    }

    hub.publish(`order:${orderId}:tracking`, { type: "status", status: "completed", price });

    await db.run("INSERT INTO order_status_log (order_id, status, changed_by) VALUES (?, 'completed', ?)", [
      orderId,
      payload.sub,
    ]);

    const updated = await db.get("SELECT * FROM orders WHERE id = ?", [orderId]);
    return { status: 200, data: updated };
  } else if (newStatus === "cancelled") {
    await db.run("UPDATE orders SET status = ?, cancelled_at = CURRENT_TIMESTAMP, cancel_reason = ? WHERE id = ?", [
      newStatus,
      cancel_reason,
      orderId,
    ]);
  } else {
    await db.run("UPDATE orders SET status = ? WHERE id = ?", [newStatus, orderId]);
  }

  await db.run("INSERT INTO order_status_log (order_id, status, changed_by) VALUES (?, ?, ?)", [
    orderId,
    newStatus,
    payload.sub,
  ]);

  // نشر التحديث لحظيًا لأي حد مشترك في شاشة تتبع الطلب ده (عميل أو صنايعي)
  hub.publish(`order:${orderId}:tracking`, { type: "status", status: newStatus });

  const updated = await db.get("SELECT * FROM orders WHERE id = ?", [orderId]);
  return { status: 200, data: updated };
}

// ---------------------------------------------------------------
// POST /orders/:id/approve-price — العميل يوافق على سعر الصنايعي
// ---------------------------------------------------------------
async function approvePrice(req, res, body, orderId) {
  const payload = await requireAuth(req);
  const order = await db.get("SELECT * FROM orders WHERE id = ?", [orderId]);
  if (!order) return { status: 404, data: { error: "order_not_found" } };
  if (payload.sub !== order.client_id) {
    return { status: 403, data: { error: "not_authorized_for_this_order" } };
  }
  if (order.status !== "price_pending") {
    return { status: 400, data: { error: "not_price_pending" } };
  }

  const price = Number(order.price);
  await db.run("UPDATE orders SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?", [orderId]);

  if (order.provider_id) {
    await db.run("UPDATE provider_profiles SET jobs_completed = jobs_completed + 1 WHERE id = ?", [order.provider_id]);

    // العمولة بتتسجل من أول تفاعل (فتح الطلب أو قبوله)، فلو الطلب ده
    // اتسجلت عمولته قبل كده منمنعش بقا نكرر المحاسبة عليه هنا.
    if (order.commission_charged_at == null) {
      const result = await walletService.recordCompletedOrder(order);
      if (result) {
        await db.run(
          "UPDATE orders SET commission_charged_at = CURRENT_TIMESTAMP, commission_percent = ?, commission_amount = ? WHERE id = ?",
          [await walletService.getCommissionPercent(), result.commission, orderId]
        );
      }
    }
  }

  await db.run("INSERT INTO order_status_log (order_id, status, changed_by) VALUES (?, 'completed', ?)", [
    orderId,
    payload.sub,
  ]);
  hub.publish(`order:${orderId}:tracking`, { type: "status", status: "completed", price });

  return { status: 200, data: await db.get("SELECT * FROM orders WHERE id = ?", [orderId]) };
}

// ---------------------------------------------------------------
// POST /orders/:id/reject-price — العميل يعترض على سعر الصنايعي
// ---------------------------------------------------------------
async function rejectPrice(req, res, body, orderId) {
  const payload = await requireAuth(req);
  const order = await db.get("SELECT * FROM orders WHERE id = ?", [orderId]);
  if (!order) return { status: 404, data: { error: "order_not_found" } };
  if (payload.sub !== order.client_id) {
    return { status: 403, data: { error: "not_authorized_for_this_order" } };
  }
  if (order.status !== "price_pending") {
    return { status: 400, data: { error: "not_price_pending" } };
  }

  // رفض السعر بيرجّع الشغلانة لحالة التنفيذ، وممكن الصنايعي يقدّم
  // سعر تاني ويعدّي بنفس الفلو (completed تاني => price_pending).
  await db.run("UPDATE orders SET status = 'in_progress', price = NULL WHERE id = ?", [orderId]);
  await db.run("INSERT INTO order_status_log (order_id, status, changed_by) VALUES (?, 'price_rejected', ?)", [
    orderId,
    payload.sub,
  ]);
  hub.publish(`order:${orderId}:tracking`, { type: "price_rejected", status: "in_progress" });

  return { status: 200, data: await db.get("SELECT * FROM orders WHERE id = ?", [orderId]) };
}

// ---------------------------------------------------------------
// GET /orders/:id
// ---------------------------------------------------------------
async function getOrder(req, res, body, query, orderId) {
  const payload = await requireAuth(req);
  const order = await db.get("SELECT * FROM orders WHERE id = ?", [orderId]);
  if (!order) return { status: 404, data: { error: "order_not_found" } };

  const isClient = payload.sub === order.client_id;
  // شاشة العميل (تتبع الطلب) بتبعت as=client — بتبص كعميل حتى لو
  // هو صنايعي معيّن لنفسه (حساب both)، فميتحظرش ولا تتتحسب عليه عمولة.
  const viewAsClient = query && query.as === "client";
  const assignedProvider = order.provider_id
    ? await db.get("SELECT * FROM provider_profiles WHERE id = ?", [order.provider_id])
    : null;
  const isAssignedProvider = assignedProvider && payload.sub === assignedProvider.user_id;

  // لو الطلب لسه pending (مفيش صنايعي معيّن)، فعشان الصياغة القديمة
  // (أمر دون provider_id) قادرين يشوفوه صنايعيه التخصص.
  let isEligibleProvider = false;
  let viewerProvider = null;
  if (isAssignedProvider) {
    viewerProvider = assignedProvider;
  } else if (!isClient && order.status === "pending" && !order.provider_id) {
    viewerProvider = await db.get("SELECT * FROM provider_profiles WHERE user_id = ?", [payload.sub]);
    if (viewerProvider) {
      const matchesCategory = await db.get(
        "SELECT 1 FROM provider_categories WHERE provider_id = ? AND category_id = ?",
        [viewerProvider.id, order.category_id]
      );
      isEligibleProvider = !!matchesCategory;
    }
  }

  if (!isClient && !isAssignedProvider && !isEligibleProvider) {
    return { status: 403, data: { error: "not_authorized_for_this_order" } };
  }

  // الصنايعي اللي عليه مستحقات عمولة وصلت للحد مينفعش يفتح طلبات جديدة
  // من "شغلي كصنايعي" (زي ما مينفعش يقبل) — يرجع يسدد المستحقات الأول
  // من شاشة المحفظة، وبعدين يرجع يفتح ويقبل عادي.
  const viewerIsProviderSide = isAssignedProvider || isEligibleProvider;
  // الكلينت شايف طلبه برا المنطق ده — حتى لو هو صنايعي معيّن لنفسه
  // (حساب both): ميتحظرش ولا بتتحسب عليه عمولة وهو بيبص في طلباته كعميل.
  if (viewerIsProviderSide && !viewAsClient && order.status === "pending" && viewerProvider) {
    const block = await walletService.getBlockStatus(viewerProvider.id);
    if (block.blocked) {
      return {
        status: 403,
        data: { error: "commission_unpaid", unpaid_commission: block.unpaid_commission, threshold: block.threshold },
      };
    }
  }

  const images = await db.all("SELECT id, image_base64 FROM order_images WHERE order_id = ?", [orderId]);

  // الخصوصية: رقم العميل بيتبعت للصنايعي بس (هو اللي بيكلم العميل)،
  // ورقم الصنايعي مبيتبعتش للعميل نهائيًا من السيرفر.
  const client = await db.get("SELECT phone_number FROM users WHERE id = ?", [order.client_id]);
  let providerName = null;
  if (order.provider_id) {
    const providerUser = await db.get(
      "SELECT u.name FROM provider_profiles pp JOIN users u ON u.id = pp.user_id WHERE pp.id = ?",
      [order.provider_id]
    );
    providerName = providerUser?.name ?? null;
  }
  const data = {
    ...order,
    images,
    // اسم الصنايعي للعرض فقط — ولو مسح اسمه نعرض "مستخدم"
    provider_name: providerName || "مستخدم",
  };
  if (viewerIsProviderSide) {
    data.client_phone = client?.phone_number ?? null;
  }

  // عمولة أول فتح للطلب: أول مرة الصنايعي المعيّن فعليًا يفتح طلب مش
  // مقبول لسه (pending)، بيتحسب عليه عمولة المنصة فورًا — حتى لو مش
  // مكمّلش على "قبول الطلب" — عشان رقم العميل وبياناته ميتنسلوش بره
  // المنصة. مرة واحدة بس لكل طلب: لو قبله بعدين (acceptOrder) مفيش
  // تسجيل تاني، وعلامة commission_charged_at هي اللي بتمنع التكرار.
  if (isAssignedProvider && !viewAsClient && order.status === "pending" && order.commission_charged_at == null) {
    const lead = await walletService.recordLeadCommission(order);
    if (lead) {
      const chargedPercent = await walletService.getCommissionPercent();
      await db.run(
        "UPDATE orders SET commission_charged_at = CURRENT_TIMESTAMP, commission_percent = ?, commission_amount = ? WHERE id = ?",
        [chargedPercent, lead.commission, order.id]
      );
      data.commission_charged = true;
      data.commission_charged_amount = lead.commission;
      data.commission_charged_percent = chargedPercent;
    }
  }

  return { status: 200, data };
}

// ---------------------------------------------------------------
// GET /orders?role=client|provider&status=
// ---------------------------------------------------------------
async function listOrders(req, query) {
  const payload = await requireAuth(req);
  const { role = "client", status } = query;

  let sql, params;
  if (role === "provider") {
    const provider = await db.get("SELECT * FROM provider_profiles WHERE user_id = ?", [payload.sub]);
    if (!provider) return { status: 200, data: { orders: [] } };
    sql =
      "SELECT o.*, u.name AS client_name, CASE WHEN o.status = 'pending' THEN NULL ELSE u.phone_number END AS client_phone FROM orders o JOIN users u ON u.id = o.client_id WHERE o.provider_id = ? AND (o.hidden_from_provider IS NULL OR o.hidden_from_provider = 0)";
    params = [provider.id];
  } else {
    // قائمة طلبات العميل: اسم الصنايعي + هل قيّم الطلب (rated)
    sql = `SELECT o.*,
       (SELECT u2.name FROM provider_profiles pp JOIN users u2 ON u2.id = pp.user_id WHERE pp.id = o.provider_id) AS provider_name,
       (SELECT COUNT(*) FROM ratings r WHERE r.order_id = o.id AND r.rating_type = 'client_to_provider') AS rated
       FROM orders o WHERE o.client_id = ? AND (o.hidden_from_client IS NULL OR o.hidden_from_client = 0)`;
    params = [payload.sub];
  }

  if (status) {
    sql += " AND status = ?";
    params.push(status);
  }
  sql += " ORDER BY created_at DESC LIMIT 50";

  const orders = await db.all(sql, params);
  return { status: 200, data: { orders, total: orders.length } };
}

// ---------------------------------------------------------------
// GET /orders/available — الطلبات المعلّقة في تخصصات الصنايعي الحالي
// ---------------------------------------------------------------
async function availableOrders(req) {
  const payload = await requireAuth(req);
  requireUserType(payload, ["provider", "both"]);

  const provider = await db.get("SELECT * FROM provider_profiles WHERE user_id = ?", [payload.sub]);
  if (!provider) return { status: 403, data: { error: "not_a_provider" } };

  const orders = await db.all(
    `SELECT o.*, u.name AS client_name,
       CASE WHEN o.status = 'pending' THEN NULL ELSE u.phone_number END AS client_phone,
       (SELECT COUNT(*) FROM order_images oi WHERE oi.order_id = o.id) AS image_count
     FROM orders o
     JOIN users u ON u.id = o.client_id
     WHERE o.status = 'pending'
       AND (o.provider_id = ? OR (o.provider_id IS NULL AND o.category_id IN (
         SELECT category_id FROM provider_categories WHERE provider_id = ?
       )))
     ORDER BY o.created_at DESC
     LIMIT 20`,
    [provider.id, provider.id]
  );

  // الصور بتتضاف للطلبات عشان الصنايعي يشوف شكل المشكلة قبل ما يقبل
  for (const o of orders) {
    const imgs = await db.all("SELECT image_base64 FROM order_images WHERE order_id = ?", [o.id]);
    o.images = imgs.map((i) => i.image_base64);

    // ملخص الكميات بصيغة مقروءة: "محارة داخلية: 40 متر²، ..."
    const details = safeParseJson(o.order_details);
    if (details) {
      const cat = await db.get("SELECT name_ar FROM categories WHERE id = ?", [o.category_id]);
      const schema = getSchemaByCategoryName(cat?.name_ar);
      const parts = [];
      if (schema) {
        parts.push(
          ...schema.items
            .filter((i) => (Number(details[i.key]) || 0) > 0)
            .map((i) => `${i.label_ar}: ${Number(details[i.key])} ${i.unit_ar}`)
        );
      }
      // الخدمات الإضافية المخصصة (لو فيها كميات) — الأسماء من الجدول
      if (o.provider_id) {
        const customs = await listCustomServices(o.provider_id);
        for (const cs of customs) {
          const q = Number(details[cs.key]) || 0;
          if (q > 0) parts.push(`${cs.name_ar}: ${q} ${cs.unit_ar || ""}`.trim());
        }
      }
      o.details_text = parts.join("، ");
    }
  }

  // حالة الحظر (مستحقات عمولة وصلت للحد) — الصنايعي يشوفها في قائمة الطلبات
  const block = await walletService.getBlockStatus(provider.id);

  return { status: 200, data: { orders, blocked: block.blocked, unpaid_commission: block.unpaid_commission } };
}

// ---------------------------------------------------------------
// PATCH /providers/me/availability — تفعيل/إلغاء "متاح الآن" + الموقع
// + المهنة الواحدة وأسعارها الخاصة بيها.
//
// الصنايعي بيشغل مهنة واحدة بس. لما يبعت category_id لازم يبعت
// pricing_data فيه سعر الوحدة لكل بند من بنود المهنة (كلها إجبارية
// وأرقام ≥ 0) — بنتحقق منها ضد مخطط المهنة في src/pricing.js.
// ---------------------------------------------------------------
async function updateAvailability(req, res, body) {
  const payload = await requireAuth(req);
  requireUserType(payload, ["provider", "both"]);

  const provider = await db.get("SELECT * FROM provider_profiles WHERE user_id = ?", [payload.sub]);
  if (!provider) return { status: 403, data: { error: "not_a_provider" } };

  const { is_available, lat, lng, hourly_rate, pricing_data } = body;

  // المهنة الجديدة: category_id مباشرة، أو أول عنصر من category_ids
  // (توافق مع نسخ التطبيق القديمة) — وفي الحالتين مهنة واحدة بس.
  let categoryId = body.category_id;
  if (categoryId == null && Array.isArray(body.category_ids) && body.category_ids.length > 0) {
    categoryId = body.category_ids[0];
  }

  if (categoryId != null) {
    const cat = await db.get("SELECT * FROM categories WHERE id = ?", [Number(categoryId)]);
    if (!cat) return { status: 400, data: { error: "invalid_category" } };

    const schema = getSchemaByCategoryName(cat.name_ar);
    if (!schema) {
      return { status: 400, data: { error: "category_pricing_not_supported", category: cat.name_ar } };
    }

    const check = validatePricingData(schema, pricing_data);
    if (!check.ok) return { status: 400, data: { error: check.error } };

    // مهنة واحدة = نمسح أي اختيارات قديمة وندوّس بواحدة بس
    await db.run("DELETE FROM provider_categories WHERE provider_id = ?", [provider.id]);
    await db.run("INSERT INTO provider_categories (provider_id, category_id) VALUES (?, ?)", [
      provider.id,
      Number(categoryId),
    ]);

    // hourly_rate بنسيبه = أرخص بند عند الصنايعي (يظهر كـ"يبدأ من" في
    // الشاشات القديمة)، و pricing_data هو المصدر الرسمي للأسعار.
    const minRate = Math.min(...Object.values(check.rates));
    await db.run(
      "UPDATE provider_profiles SET pricing_data = ?, hourly_rate = ? WHERE id = ?",
      [JSON.stringify(check.rates), minRate, provider.id]
    );
  } else if (pricing_data != null) {
    // تحديث أسعار المهنة الحالية من غير تغييرها
    const pcRow = await getProviderCategoryWithSchema(provider.id);
    if (!pcRow) return { status: 400, data: { error: "no_category_selected_yet" } };

    const check = validatePricingData(pcRow.schema, pricing_data);
    if (!check.ok) return { status: 400, data: { error: check.error } };

    const minRate = Math.min(...Object.values(check.rates));
    await db.run(
      "UPDATE provider_profiles SET pricing_data = ?, hourly_rate = ? WHERE id = ?",
      [JSON.stringify(check.rates), minRate, provider.id]
    );
  }

  await db.run(
    `UPDATE provider_profiles
     SET is_available = ?, current_lat = COALESCE(?, current_lat), current_lng = COALESCE(?, current_lng),
         hourly_rate = COALESCE(?, hourly_rate),
         location_updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [is_available ? 1 : 0, lat ?? null, lng ?? null, hourly_rate != null ? Number(hourly_rate) : null, provider.id]
  );

  // بندمج الخدمات المخصصة اللي الصنايعي ضافها جوه pricing_data (دي
  // هتظهر للعميل في تفاصيل الطلب كبنود إضافية قابلة للحساب).
  await syncPricingWithCustom(provider.id);

  const updated = await db.get("SELECT * FROM provider_profiles WHERE id = ?", [provider.id]);
  updated.pricing_data = safeParseJson(updated.pricing_data);
  const pcRow = await getProviderCategoryWithSchema(provider.id);
  updated.category_id = pcRow ? pcRow.category_id : null;
  updated.custom_services = await listCustomServices(provider.id);
  return { status: 200, data: updated };
}

// ---------------------------------------------------------------
// POST /providers/me/location — تحديث الموقع اللحظي (بيتنادى كل كام ثانية
// وقت "في الطريق")، وبينشر التحديث فورًا لأي شاشة تتبع مشتركة.
// ---------------------------------------------------------------
async function updateLiveLocation(req, res, body) {
  const payload = await requireAuth(req);
  requireUserType(payload, ["provider", "both"]);

  const provider = await db.get("SELECT * FROM provider_profiles WHERE user_id = ?", [payload.sub]);
  if (!provider) return { status: 403, data: { error: "not_a_provider" } };

  const { lat, lng } = body;
  if (lat == null || lng == null) return { status: 400, data: { error: "lat_lng_required" } };

  await db.run(
    "UPDATE provider_profiles SET current_lat = ?, current_lng = ?, location_updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [lat, lng, provider.id]
  );

  // لو الصنايعي في رحلة نشطة دلوقتي، ابعت الموقع لشاشة تتبع العميل فورًا
  const activeOrder = await db.get(
    "SELECT id FROM orders WHERE provider_id = ? AND status IN ('accepted','on_way') ORDER BY created_at DESC LIMIT 1",
    [provider.id]
  );
  if (activeOrder) {
    hub.publish(`order:${activeOrder.id}:tracking`, { type: "location", lat, lng });
  }

  return { status: 200, data: { message: "location_updated" } };
}

// ---------------------------------------------------------------
// POST /orders/:id/rate
// ---------------------------------------------------------------
async function rateOrder(req, res, body, orderId) {
  const payload = await requireAuth(req);
  const { rating_value, comment } = body;

  if (!rating_value || rating_value < 1 || rating_value > 5) {
    return { status: 400, data: { error: "rating_value_must_be_1_to_5" } };
  }

  const order = await db.get("SELECT * FROM orders WHERE id = ?", [orderId]);
  if (!order) return { status: 404, data: { error: "order_not_found" } };
  if (order.status !== "completed") {
    return { status: 400, data: { error: "can_only_rate_completed_orders" } };
  }

  const provider = order.provider_id ? await db.get("SELECT * FROM provider_profiles WHERE id = ?", [order.provider_id]) : null;

  let ratingType, ratedUser;
  if (payload.sub === order.client_id) {
    ratingType = "client_to_provider";
    ratedUser = provider?.user_id;
  } else if (provider && payload.sub === provider.user_id) {
    ratingType = "provider_to_client";
    ratedUser = order.client_id;
  } else {
    return { status: 403, data: { error: "not_a_party_to_this_order" } };
  }

  const existing = await db.get("SELECT * FROM ratings WHERE order_id = ? AND rating_type = ?", [orderId, ratingType]);
  if (existing) {
    return { status: 409, data: { error: "already_rated" } };
  }

  const id = uuid();
  await db.run(
    `INSERT INTO ratings (id, order_id, rating_type, rated_by, rated_user, rating_value, comment)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, orderId, ratingType, payload.sub, ratedUser, rating_value, comment || null]
  );

  // لو العميل هو اللي بيقيّم، نحدّث متوسط تقييم الصنايعي فورًا
  if (ratingType === "client_to_provider" && provider) {
    const stats = await db.get(
      "SELECT AVG(rating_value) AS avg, COUNT(*) AS count FROM ratings WHERE rated_user = ? AND rating_type = 'client_to_provider'",
      [provider.user_id]
    );
    await db.run("UPDATE provider_profiles SET rating_avg = ?, rating_count = ? WHERE id = ?", [
      Math.round(stats.avg * 10) / 10,
      stats.count,
      provider.id,
    ]);
  }

  return { status: 201, data: { message: "rating_submitted", rating_type: ratingType } };
}

// ---------------------------------------------------------------
// POST /orders/clear-completed — "مسح السجل": بيخفي الطلبات المكتملة
// (completed) من عند اللي بيمسح بس، من غير ما يمسحها من عند حد تاني
// ولا يمسّ أي طلب لسه شغال. بيغطي دور العميل والصنايعي مع بعض.
// ---------------------------------------------------------------
async function clearCompletedOrders(req) {
  const payload = await requireAuth(req);
  const provider = await db.get("SELECT * FROM provider_profiles WHERE user_id = ?", [payload.sub]);

  let cleared = 0;
  if (payload.user_type === "client" || payload.user_type === "both") {
    const r = await db.run(
      "UPDATE orders SET hidden_from_client = 1 WHERE client_id = ? AND status = 'completed' AND (hidden_from_client IS NULL OR hidden_from_client = 0)",
      [payload.sub]
    );
    cleared += r.changes || 0;
  }
  if ((payload.user_type === "provider" || payload.user_type === "both") && provider) {
    const r = await db.run(
      "UPDATE orders SET hidden_from_provider = 1 WHERE provider_id = ? AND status = 'completed' AND (hidden_from_provider IS NULL OR hidden_from_provider = 0)",
      [provider.id]
    );
    cleared += r.changes || 0;
  }

  return { status: 200, data: { cleared } };
}

module.exports = {
  listCategories,
  nearbyProviders,
  createOrder,
  acceptOrder,
  setOrderPrice,
  updateStatus,
  approvePrice,
  rejectPrice,
  getOrder,
  listOrders,
  availableOrders,
  updateAvailability,
  updateLiveLocation,
  rateOrder,
  getMyProvider,
  clearCompletedOrders,
  listCustomServices,
  addCustomService,
  deleteCustomService,
  getMyCustomServices,
};

// ---------------------------------------------------------------
// GET /providers/me — البروفايل الحالي للصنايعي (مطلوب عشان يعرف
// اسم قناة الإشعارات الخاصة بيه: provider:{id}:incoming)
// ---------------------------------------------------------------
async function getMyProvider(req) {
  const payload = await requireAuth(req);
  const provider = await db.get("SELECT * FROM provider_profiles WHERE user_id = ?", [payload.sub]);
  if (!provider) return { status: 403, data: { error: "not_a_provider" } };
  provider.pricing_data = safeParseJson(provider.pricing_data);
  const pcRow = await getProviderCategoryWithSchema(provider.id);
  provider.category_id = pcRow ? pcRow.category_id : null;
  provider.custom_services = await listCustomServices(provider.id);
  return { status: 200, data: provider };
}

// ---------------------------------------------------------------
// الخدمات الإضافية المخصصة اللي الصنايعي بيضيفها بنفسه فوق البنود
// الإجبارية — كل خدمة عندها key (custom_N) بيخليها تظهر في تفاصيل
// الطلب كأنها بند عادي، العميل بيحسب سعرها = السعر أ— الكمية.
// ---------------------------------------------------------------
async function listCustomServices(providerId) {
  return db.all(
    "SELECT key, name_ar, unit_ar, price FROM provider_custom_services WHERE provider_id = ? ORDER BY created_at",
    [providerId]
  );
}

async function getMyCustomServices(req) {
  const payload = await requireAuth(req);
  requireUserType(payload, ["provider", "both"]);
  const provider = await db.get("SELECT * FROM provider_profiles WHERE user_id = ?", [payload.sub]);
  if (!provider) return { status: 403, data: { error: "not_a_provider" } };
  const services = await listCustomServices(provider.id);
  return { status: 200, data: { custom_services: services } };
}

function customServicesKeyMap (services) {
  const map = {};
  for (const s of services || []) {
    map[s.key] = Number(s.price);
  }
  return map;
}

async function addCustomService(req, res, body) {
  const payload = await requireAuth(req);
  requireUserType(payload, ["provider", "both"]);
  const provider = await db.get("SELECT * FROM provider_profiles WHERE user_id = ?", [payload.sub]);
  if (!provider) return { status: 403, data: { error: "not_a_provider" } };

  const name = (body.name_ar || "").trim();
  const unit = (body.unit_ar || "").trim();
  const price = Number(body.price);
  if (!name || !Number.isFinite(price) || price < 0) {
    return { status: 400, data: { error: "custom_service_invalid" } };
  }

  const existing = await db.all(
    "SELECT key FROM provider_custom_services WHERE provider_id = ?",
    [provider.id]
  );
  const nextIndex = existing.length + 1;
  let key = "custom_" + nextIndex;
  const takenKeys = new Set(existing.map((e) => e.key));
  while (takenKeys.has(key)) {
    key = "custom_" + (++nextIndex);
  }

  await db.run(
    "INSERT INTO provider_custom_services (provider_id, key, name_ar, unit_ar, price) VALUES (?, ?, ?, ?, ?)",
    [provider.id, key, name, unit || null, price]
  );

  const services = await listCustomServices(provider.id);
  // بنحدّث أسعار الصنايعي على السيرفر عشان الخدمة الجديدة تظهر في
  // تفاصيل الطلب وهي بتتحسب في السعر الكلي.
  await syncPricingWithCustom(provider.id);

  return { status: 200, data: { custom_service: services[services.length - 1], custom_services: services } };
}

async function deleteCustomService(req, res, body, query, key) {
  const payload = await requireAuth(req);
  requireUserType(payload, ["provider", "both"]);
  const provider = await db.get("SELECT * FROM provider_profiles WHERE user_id = ?", [payload.sub]);
  if (!provider) return { status: 403, data: { error: "not_a_provider" } };

  const result = await db.run(
    "DELETE FROM provider_custom_services WHERE provider_id = ? AND key = ?",
    [provider.id, key]
  );
  if ((result && result.changes) === 0) {
    return { status: 404, data: { error: "custom_service_not_found" } };
  }

  await syncPricingWithCustom(provider.id);
  const services = await listCustomServices(provider.id);
  return { status: 200, data: { custom_services: services } };
}

// بندمج الخدمات المخصصة جوه pricing_data (كمفاتيح custom_N) عشان
// العميل في تفاصيل الطلب يقدر يحسب سعرها ويشوفها كبند عادي.
async function syncPricingWithCustom(providerId) {
  const row = await db.get("SELECT pricing_data FROM provider_profiles WHERE id = ?", [providerId]);
  const rates = safeParseJson(row?.pricing_data) || {};
  // بنشيل أي مفاتيح custom قديمة من جوه pricing_data عشان نعيد بنائها
  // من الجدول بشكل نظيف (دي المصدر الرسمي للأسماء والأسعار).
  for (const k of Object.keys(rates)) {
    if (k.startsWith("custom_")) delete rates[k];
  }
  const services = await listCustomServices(providerId);
  for (const s of services) {
    rates[s.key] = Number(s.price);
  }
  await db.run("UPDATE provider_profiles SET pricing_data = ? WHERE id = ?", [
    JSON.stringify(rates),
    providerId,
  ]);

  // بنحدّث أرخص سعر (hourly_rate) ليعكس كمان الخدمات المخصصة لو
  // فتحت، عشان شاشات العرض القديمة تفضل مضبوطة.
  const allRates = Object.values(rates).map(Number);
  if (allRates.length > 0) {
    const minRate = Math.min(...allRates);
    await db.run("UPDATE provider_profiles SET hourly_rate = ? WHERE id = ?", [
      minRate,
      providerId,
    ]);
  }
}
