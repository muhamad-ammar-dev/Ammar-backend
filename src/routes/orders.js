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
const { getDefaultPrice, estimateRequestPrice, getMinPrice } = require("../defaultPrices");

// أقصى مسافة (كم) بين العميل والصنايعي عشان الطلب المفتوح يوصل له.
// الطلب مبيوصلش لكل صنايعية المهنة على التطبيق، بس اللي مسافتهم ≤ الرقم ده.
const SERVICE_RADIUS_KM = 20;

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

// وصف مختصر للبند/البنود المختارة في الطلب (للعرض في الإشعارات)
function buildRequestDetailsText(categoryName, orderDetails, description) {
  const schema = getSchemaByCategoryName(categoryName);
  if (schema && orderDetails && typeof orderDetails === "object") {
    const parts = [];
    for (const item of schema.items) {
      const qty = Number(orderDetails[item.key]);
      if (Number.isFinite(qty) && qty > 0) {
        parts.push(`${item.label_ar}: ${qty} ${item.unit_ar}`);
      }
    }
    if (parts.length) return parts.join("، ");
  }
  return String(description || "").trim();
}

// بنود الطلب المختارة مع أسمائها ووحداتها وكمياتها (للعرض في قالب المزاد).
// بتستخدم مخطط المهنة عشان تحوّل مفاتيح البنود لأسماء عربية.
function resolveOrderItems(categoryName, orderDetails) {
  const details = typeof orderDetails === "string" ? safeParseJson(orderDetails) : orderDetails;
  const schema = getSchemaByCategoryName(categoryName);
  if (!schema || !details || typeof details !== "object") return [];
  const out = [];
  for (const item of schema.items) {
    const qty = Number(details[item.key]);
    if (Number.isFinite(qty) && qty > 0) {
      out.push({ key: item.key, label_ar: item.label_ar, unit_ar: item.unit_ar, qty });
    }
  }
  return out;
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

// أسعار الصنايعي بتتخزن في pricing_data بمفاتيح موّحدة بالشكل
// "<category_id>:<item_key>" عشان الصنايعي يقدر يشتغل أكتر من مهنة من
// غير ما مفاتيح البنود تتعارض بين المهن. الدالة دي بتطلّع أسعار مهنة
// واحدة بس، وبتدعم كمان البيانات القديمة المسطّحة (مهنة واحدة زمان).
function ratesForCategory(rates, categoryId) {
  if (!rates || typeof rates !== "object" || Array.isArray(rates)) return {};
  const prefix = String(categoryId) + ":";
  const out = {};
  for (const [key, value] of Object.entries(rates)) {
    if (key.startsWith(prefix)) {
      out[key.slice(prefix.length)] = value;
    } else if (!key.includes(":")) {
      // توافق قديم (بيانات مسطّحة لمهنة واحدة) + الخدمات المخصصة
      // (مفاتيحها custom_N عامة على كل المهن مش مربوطة بمهنة).
      out[key] = value;
    }
  }
  return out;
}

// كل المهن بتاعة الصنايعي مع بنود التسعير والأسعار المحفوظة لكل مهنة
// (الأسعار بترجع مسطّحة بالمفتاح الأصلي للبند زي ما التطبيق متوقع).
async function getProviderCategoriesWithSchema(providerId, rates) {
  const rows = await db.all(
    `SELECT c.id, c.name_ar, c.icon
     FROM provider_categories pc JOIN categories c ON c.id = pc.category_id
     WHERE pc.provider_id = ? ORDER BY c.name_ar`,
    [providerId]
  );
  return rows.map((row) => {
    const schema = getSchemaByCategoryName(row.name_ar);
    return {
      id: row.id,
      name_ar: row.name_ar,
      icon: row.icon,
      pricing_items: schema ? schema.items.map((item) => ({ ...item, default_price: getDefaultPrice(row.name_ar, item.key) })) : [],
      rates: rates ? ratesForCategory(rates, row.id) : {},
    };
  });
}

// هل الـ pricing_data الجاية من التطبيق متعدّدة المهن؟
// (يعني { "<categoryId>": { itemKey: price } })
function isNestedPricingData(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  return Object.values(input).some(
    (v) => v && typeof v === "object" && !Array.isArray(v)
  );
}

// بنشيل أي مفاتيح قديمة مسطّحة (لمهنة واحدة زمان) ونسيب المفاتيح
// الموّحدة بالمهنة (<categoryId>:<itemKey>) والخدمات المخصصة (custom_N).
// بنستخدمها قبل ما نكتب أسعار بصيغة جديدة عشان ميتسرّبش سعر مهنة
// قديمة لمهنة تانية.
function stripLegacyFlatRates(rates) {
  const out = {};
  for (const [key, value] of Object.entries(rates || {})) {
    if (key.includes(":") || key.startsWith("custom_")) out[key] = value;
  }
  return out;
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

// كل الصنايعية المتاحين في مهنة معيّنة اللي مسافتهم من نقطة معيّنة
// (العميل) ≤ radiusKm. بترجع provider_id + user_id + distance_km.
// الصنايعي من غير موقع (current_lat/lng = null) مبيتحسبش قريب.
async function nearbyCategoryProviders(categoryId, lat, lng, radiusKm = SERVICE_RADIUS_KM) {
  const rows = await db.all(
    `SELECT pp.id AS provider_id, pp.user_id AS user_id,
            pp.current_lat AS current_lat, pp.current_lng AS current_lng
     FROM provider_categories pc
     JOIN provider_profiles pp ON pp.id = pc.provider_id
     JOIN users u ON u.id = pp.user_id
     WHERE pc.category_id = ? AND pp.is_available = 1 AND u.is_active = 1`,
    [categoryId]
  );
  return rows
    .filter((p) => p.current_lat != null && p.current_lng != null)
    .map((p) => ({ ...p, distance_km: haversineKm(lat, lng, p.current_lat, p.current_lng) }))
    .filter((p) => p.distance_km <= radiusKm);
}

// ---------------------------------------------------------------
// مهن مؤقتة مخفية من الاستعراض (تسجيل صنايعي + اطلب خدمة + محتاج مين).
// الإخفاء ده سطحي بس: كل بيانات المهنة (مخطط التسعير، البنود، الطلبات،
// حسابات الصنايعية المسجلة فيها) موجودة في القاعدة زي ما هي. عشان ترجع
// المهنة تاني احذف اسمها من القائمة دي ودوس deploy.
// ---------------------------------------------------------------
const HIDDEN_CATEGORY_NAMES = new Set([
  "بناء وواجهات حجرية",
  "باركيه",
  "حداد",
  "جبس بلدي ومصيص",
  "ستائر وتنجيد",
  "زجاج وسيكوريت",
  "رخام وجرانيت",
  "جبسيوم بورد",
  "نقل اثاث",
  "ونش تشوين",
  "تركيب كرانيش فوم",
  "مكافحة حشرات وقوارض",
  "حمامات سباحة",
]);

// ---------------------------------------------------------------
// GET /categories — مع بنود تسعير كل مهنة (pricing_items) عشان
// شاشتين التطبيق (أسعار الصنايعي + تفاصيل طلب العميل) يتبنوا ديناميكيًا.
// ---------------------------------------------------------------
async function listCategories(req) {
  const categories = (await db.all("SELECT id, name_ar, icon FROM categories")).filter(
    (c) => !HIDDEN_CATEGORY_NAMES.has(c.name_ar)
  );
  const data = categories.map((c) => {
    const schema = getSchemaByCategoryName(c.name_ar);
    return {
      ...c,
      // السعر التقديري (تقريبي للسوق المصري) لكل بند، مع "يبدأ من" للمهنة
      start_price: getMinPrice(c.name_ar),
      pricing_items: schema
        ? schema.items.map((item) => ({ ...item, default_price: getDefaultPrice(c.name_ar, item.key) }))
        : null,
    };
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
      // أسعاره الخاصة بالمهنة اللي العميل بيدور فيها بس (الصنايعي ممكن
      // يكون شغال أكتر من مهنة، وكل مهنة ليها أسعارها) — التطبيق بيحسب
      // منه سعر الطلب التقديري على طول.
      pricing_data: ratesForCategory(safeParseJson(p.pricing_data), categoryId),
      distance_km: Math.round(p.distance_km * 10) / 10,
      eta_minutes: Math.max(3, Math.round(p.distance_km * 3)), // تقدير تقريبي بسيط
    }));
  // الخدمات الإضافية المخصصة لكل صنايعي (بيضيفها بنفسه) — بنقراها هنا
  // بإجراء واحد لكل provider موجود في القايمة النهائية.
  for (const p of nearby) {
    p.custom_services = await db.all(
      "SELECT key, name_ar, unit_ar, price, category_id FROM provider_custom_services WHERE provider_id = ?",
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

  // المخطط بيتحدد حسب المهنة اللي العميل اختارها في الطلب نفسه (مش
  // أول مهنة عند الصنايعي) — لأن الصنايعي ممكن يكون شغال أكتر من مهنة.
  const orderCategory = await db.get("SELECT name_ar FROM categories WHERE id = ?", [category_id]);
  const schema = orderCategory ? getSchemaByCategoryName(orderCategory.name_ar) : null;

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
    // أسعار الصنايعي في المهنة المطلوبة بالذات.
    const rates = ratesForCategory(safeParseJson(provider.pricing_data), category_id);
    if (!rates || Object.keys(rates).length === 0) {
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

  // منع قبول طلبات جديدة لو عليه عمولة مستحقة وصلت للحد.
  // استثناء: طلب هو بالفعل فتحه واتحسبت عمولته (commission_charged_at) —
  // ده مينفعش يتحبس فيه وهو في نص الطريق، والقبول هنا بيسجّل الإيراد بس.
  const block = await walletService.getBlockStatus(provider.id);
  if (block.blocked && order.commission_charged_at == null) {
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
  // معلومات العمولة بترجع للتطبيق عشان يعرّف الصنايعي إن العمولة
  // اتسجلت عليه في المحفظة لحظة ما دخل شاشة "شغلانة حالية".
  return {
    status: 200,
    data: {
      ...updated,
      commission_charged: updated.commission_charged_at != null,
      commission_charged_amount: Number(updated.commission_amount) || 0,
      commission_charged_percent: Number(updated.commission_percent) || 0,
    },
  };
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
  //
  // الشغلانة "لمبدأ الشغل" = لسه pending أو accepted ومن غير عمولة مسجّلة
  // عليها لسه وقبل ما ندخل مرحلة التنفيذ. فالصنايعي عليه مستحقات عمولة ما
  // ينفعش يخش شغلانة جديدة (حتى في فلو عروض الأسعار) — لحد ما يسدّد.  // الشغلانة اللي عمولتها اتسجلت أصلًا (أو اللي دخلت on_way..) تفضل
  // متاحة عشان يخلّصها ويستلم من غير ما نحبسه في نص شغل.
  const isPreStartOrder = order.status === "pending" || order.status === "accepted";
  if (viewerIsProviderSide && !viewAsClient && viewerProvider && isPreStartOrder && order.commission_charged_at == null) {
    const block = await walletService.getBlockStatus(viewerProvider.id);
    if (block.blocked) {
      return {
        status: 403,
        data: { error: "commission_unpaid", unpaid_commission: block.unpaid_commission, threshold: block.threshold },
      };
    }
  }

  const images = await db.all("SELECT id, image_base64 FROM order_images WHERE order_id = ?", [orderId]);
  const orderCategory = await db.get("SELECT name_ar FROM categories WHERE id = ?", [order.category_id]);

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
    items: resolveOrderItems(orderCategory?.name_ar, order.order_details),
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
      "SELECT o.*, u.name AS client_name, c.name_ar AS category_name, CASE WHEN o.status = 'pending' THEN NULL ELSE u.phone_number END AS client_phone FROM orders o JOIN users u ON u.id = o.client_id JOIN categories c ON c.id = o.category_id WHERE o.provider_id = ? AND (o.hidden_from_provider IS NULL OR o.hidden_from_provider = 0)";
    params = [provider.id];
  } else {
    // قائمة طلبات العميل: اسم الصنايعي + هل قيّم الطلب (rated)
    sql = `SELECT o.*, c.name_ar AS category_name,
       (SELECT u2.name FROM provider_profiles pp JOIN users u2 ON u2.id = pp.user_id WHERE pp.id = o.provider_id) AS provider_name,
       (SELECT COUNT(*) FROM ratings r WHERE r.order_id = o.id AND r.rating_type = 'client_to_provider') AS rated
       FROM orders o JOIN categories c ON c.id = o.category_id WHERE o.client_id = ? AND (o.hidden_from_client IS NULL OR o.hidden_from_client = 0)`;
    params = [payload.sub];
  }

  if (status) {
    sql += " AND status = ?";
    params.push(status);
  }
  sql += " ORDER BY o.created_at DESC LIMIT 50";

  const orders = (await db.all(sql, params)).map((o) => ({
    ...o,
    items: resolveOrderItems(o.category_name, o.order_details),
  }));
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

  // المهن: category_ids (مهنة أو أكتر) أو category_id الواحدة للتوافق
  // مع نسخ التطبيق القديمة.
  let categoryIds = null;
  if (Array.isArray(body.category_ids) && body.category_ids.length > 0) {
    categoryIds = body.category_ids.map(Number).filter((n) => Number.isFinite(n));
  } else if (body.category_id != null) {
    categoryIds = [Number(body.category_id)];
  }

  const nested = isNestedPricingData(pricing_data);
  // بنجمع كل أسعار المهن المختارة في ماب واحد بمفاتيح موّحدة بالشكل
  // "<category_id>:<item_key>" عشان ميحصلش تعارض بين مفاتيح المهن.
  const asNamespaced = {};
  let hasRates = false;
  // الأسعار بقت اختيارية: التطبيق دلوقتي بيختار المهن من غير ما يسجّل
  // أسعار (السعر بيتحدد في العروض على الطلب نفسه). لو مفيش أسعار
  // مبعوتة بنسجّل المهن وبس، وبنفضّي أي أسعار قديمة.
  const hasPricingInput =
    pricing_data != null &&
    typeof pricing_data === "object" &&
    !Array.isArray(pricing_data) &&
    Object.keys(pricing_data).length > 0;

  if (categoryIds && categoryIds.length > 0) {
    // اختيار/تغيير المهن.
    for (const categoryId of categoryIds) {
      const cat = await db.get("SELECT * FROM categories WHERE id = ?", [categoryId]);
      if (!cat) return { status: 400, data: { error: "invalid_category" } };

      // لو مفيش أسعار مبعوتة مع المهن، بنسجّل المهنة من غير تحقق من بنودها.
      if (!hasPricingInput) continue;

      const schema = getSchemaByCategoryName(cat.name_ar);
      if (!schema) {
        return { status: 400, data: { error: "category_pricing_not_supported", category: cat.name_ar } };
      }

      // لو الأسعار واصلة متعدّدة المهن ناخد بتاعة المهنة دي بالذات،
      // لو مسطّحة (نسخة قديمة) بنستخدمها لما تكون مهنة واحدة بس.
      const catInput = nested
        ? (pricing_data[String(categoryId)] ?? pricing_data[categoryId])
        : (categoryIds.length === 1 ? pricing_data : null);

      const check = validatePricingData(schema, catInput);
      if (!check.ok) return { status: 400, data: { error: check.error, category_id: categoryId } };

      for (const [key, value] of Object.entries(check.rates)) {
        asNamespaced[`${categoryId}:${key}`] = value;
      }
      hasRates = true;
    }

    // المهن الجديدة بتدوّس على أي اختيارات قديمة (بنمسح ونكتب من جديد).
    await db.run("DELETE FROM provider_categories WHERE provider_id = ?", [provider.id]);
    for (const categoryId of categoryIds) {
      await db.run("INSERT INTO provider_categories (provider_id, category_id) VALUES (?, ?)", [
        provider.id,
        categoryId,
      ]);
    }
  } else if (hasPricingInput) {
    // تحديث أسعار المهن الحالية من غير تغييرها.
    const currentCats = await db.all(
      `SELECT c.id AS category_id, c.name_ar
       FROM provider_categories pc JOIN categories c ON c.id = pc.category_id
       WHERE pc.provider_id = ?`,
      [provider.id]
    );
    if (currentCats.length === 0) {
      return { status: 400, data: { error: "no_category_selected_yet" } };
    }

    // بنبدأ من الأسعار المحفوظة عشان أي مهنة مش مبعوتة في الطلب تفضل
    // بأسعارها زي ما هي (تحديث جزئي).
    Object.assign(asNamespaced, safeParseJson(provider.pricing_data) || {});

    if (nested) {
      // تحديث المهن المبعوتة (كل المهن عادةً) مع بعض.
      for (const cat of currentCats) {
        const catInput = pricing_data[String(cat.category_id)] ?? pricing_data[cat.category_id];
        if (catInput == null) continue;
        const schema = getSchemaByCategoryName(cat.name_ar);
        if (!schema) continue;
        const check = validatePricingData(schema, catInput);
        if (!check.ok) return { status: 400, data: { error: check.error, category_id: cat.category_id } };
        for (const [key, value] of Object.entries(check.rates)) {
          asNamespaced[`${cat.category_id}:${key}`] = value;
        }
        hasRates = true;
      }
    } else {
      // توافق قديم: أسعار مسطّحة = أول مهنة بس.
      const first = currentCats[0];
      const schema = getSchemaByCategoryName(first.name_ar);
      if (!schema) {
        return { status: 400, data: { error: "category_pricing_not_supported", category: first.name_ar } };
      }
      const check = validatePricingData(schema, pricing_data);
      if (!check.ok) return { status: 400, data: { error: check.error } };
      for (const [key, value] of Object.entries(check.rates)) {
        asNamespaced[`${first.category_id}:${key}`] = value;
      }
      hasRates = true;
    }
  }

  if (hasRates) {
    // hourly_rate بنسيبه = أرخص بند عند الصنايعي (يظهر كـ"يبدأ من" في
    // الشاشات القديمة)، و pricing_data هو المصدر الرسمي للأسعار.
    const minRate = Math.min(...Object.values(asNamespaced));
    await db.run(
      "UPDATE provider_profiles SET pricing_data = ?, hourly_rate = ? WHERE id = ?",
      [JSON.stringify(asNamespaced), Number.isFinite(minRate) ? minRate : 0, provider.id]
    );
  } else if (categoryIds && categoryIds.length > 0) {
    // المهن اتغيّرت من غير أسعار — بنفضّي أي أسعار قديمة عشان ميفضلش
    // سعر مخلف من مهن مش مختارة دلوقتي.
    await db.run(
      "UPDATE provider_profiles SET pricing_data = '{}', hourly_rate = 0 WHERE id = ?",
      [provider.id]
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
  const cats = await getProviderCategoriesWithSchema(provider.id, updated.pricing_data);
  updated.categories = cats;
  updated.category_ids = cats.map((c) => c.id);
  updated.category_id = cats.length ? cats[0].id : null;
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
    // مع الطلبات المكتملة: نخفي كمان طلبات عروض الأسعار المقفولة
    // (waiting_for_quotes خلصت — بقت accepted). بس اللي لسه مفتوح
    // نسيبه زي ما هو.
    const sr = await db.run(
      "UPDATE service_requests SET hidden_from_client = 1 WHERE client_id = ? AND status != 'waiting_for_quotes' AND (hidden_from_client IS NULL OR hidden_from_client = 0)",
      [payload.sub]
    );
    cleared += sr.changes || 0;
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

// ---------------------------------------------------------------
// GET/POST /service-requests — طلبات العملاء التي تنتظر أسعارًا من
// الصنايعية. الطلب مفتوح، وكل صنايعي يضيف عرضه دون تحديد الطلب مسبقًا.
// ---------------------------------------------------------------
async function createServiceRequest(req, res, body) {
  const payload = await requireAuth(req);
  if (payload.user_type !== "client" && payload.user_type !== "both") {
    return { status: 403, data: { error: "client_account_required" } };
  }

  const { category_id, address_text, lat, lng, description, order_details } = body;
  if (!category_id || !address_text || lat == null || lng == null || !String(description || "").trim()) {
    return { status: 400, data: { error: "category_address_lat_lng_description_required" } };
  }
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) {
    return { status: 400, data: { error: "invalid_location" } };
  }

  const category = await db.get("SELECT id, name_ar FROM categories WHERE id = ?", [category_id]);
  if (!category) return { status: 404, data: { error: "category_not_found" } };

  // السعر التقديري (نقطة انطلاق العميل): لو العميل بعت suggested_price نستخدمه،
  // وإلا بنحسبه من البنود المختارة × الأسعار التقريبية للسوق المصري.
  let price = Number(body.suggested_price);
  if (!Number.isFinite(price) || price <= 0) {
    price = estimateRequestPrice(category.name_ar, order_details).estimated || null;
  } else {
    price = round2(price);
  }
  if (price != null && price <= 0) price = null;

  const id = uuid();
  await db.run(
    `INSERT INTO service_requests
     (id, client_id, category_id, status, description, address_text, lat, lng, order_details, price)
     VALUES (?, ?, ?, 'waiting_for_quotes', ?, ?, ?, ?, ?, ?)`,
    [
      id,
      payload.sub,
      category_id,
      description.trim(),
      address_text.trim(),
      Number(lat),
      Number(lng),
      order_details ? JSON.stringify(order_details) : null,
      price,
    ]
  );
  const request = await db.get("SELECT * FROM service_requests WHERE id = ?", [id]);
  const client = await db.get("SELECT name FROM users WHERE id = ?", [payload.sub]);

  // بث الطلب لحظيًا لكل الصنايعية المتاحين في نفس المهنة (من الـ WebSocket)
  const broadcastPayload = {
    type: "new_service_request",
    request: {
      id: request.id,
      category_id: request.category_id,
      category_name: category.name_ar,
      client_name: (client && client.name) || "عميل",
      description: request.description,
      address_text: request.address_text,
      lat: request.lat,
      lng: request.lng,
      price: request.price,
      order_details: safeParseJson(request.order_details),
      created_at: request.created_at,
    },
  };
  // الصنايعية القريبين بس (نفس المهنة وجوه نطاق SERVICE_RADIUS_KM من
  // العميل) — الطلب مبيوصلش لكل صنايعية المهنة على التطبيق.
  const nearby = await nearbyCategoryProviders(
    request.category_id,
    Number(lat),
    Number(lng),
    SERVICE_RADIUS_KM
  );

  // بث لحظي على قناة كل صنايعي قريب (الشاشة بتسمع لـ provider:{id}:incoming)
  for (const p of nearby) {
    hub.publish(`provider:${p.provider_id}:incoming`, broadcastPayload);
  }
  // قناة المهنة تفضل للتوافق مع أي عميل بيسمع عليها
  hub.publish(`orders:available:cat:${request.category_id}`, broadcastPayload);

  // إشعار push على تليفونات الصنايعية القريبين بس
  const detailsText = buildRequestDetailsText(category.name_ar, safeParseJson(request.order_details), request.description);
  if (nearby.length) {
    fcm.sendToUsers(
      nearby.map((p) => p.user_id),
      {
        title: "🔔 طلب جديد في مهنتك",
        body: `${detailsText} — ${request.address_text}`,
        data: { type: "new_service_request", service_request_id: request.id, category_id: request.category_id },
      }
    );
  }

  return { status: 201, data: { ...request, category_name: category.name_ar } };
}

async function listServiceRequests(req) {
  const payload = await requireAuth(req);
  const requests = (await db.all(
    `SELECT sr.*, c.name_ar AS category_name,
        (SELECT COUNT(*) FROM service_request_quotes q WHERE q.service_request_id = sr.id AND q.status = 'pending') AS quote_count,
        (SELECT AVG(q.price) FROM service_request_quotes q WHERE q.service_request_id = sr.id AND q.status = 'pending') AS average_price
     FROM service_requests sr
     JOIN categories c ON c.id = sr.category_id
     WHERE sr.client_id = ? AND (sr.hidden_from_client IS NULL OR sr.hidden_from_client = 0)
     ORDER BY sr.created_at DESC`,
    [payload.sub]
  )).map((r) => ({
    ...r,
    items: resolveOrderItems(r.category_name, r.order_details),
  }));
  return { status: 200, data: { requests, total: requests.length } };
}

async function availableServiceRequests(req) {
  const payload = await requireAuth(req);
  requireUserType(payload, ["provider", "both"]);

  const provider = await db.get("SELECT * FROM provider_profiles WHERE user_id = ?", [payload.sub]);
  if (!provider) return { status: 403, data: { error: "not_a_provider" } };
  if (!provider.is_available) return { status: 409, data: { error: "provider_not_available" } };

  const categoryIds = await db.all(
    "SELECT category_id FROM provider_categories WHERE provider_id = ?",
    [provider.id]
  );
  const requestedIds = categoryIds.map((row) => row.category_id);
  if (!requestedIds.length) return { status: 200, data: { requests: [], total: 0 } };

  const placeholders = requestedIds.map(() => "?").join(", ");
  const rows = await db.all(
    `SELECT sr.*, c.name_ar AS category_name, u.name AS client_name,
            (SELECT COUNT(*) FROM service_request_quotes q WHERE q.service_request_id = sr.id AND q.status = 'pending') AS quote_count,
            (SELECT AVG(q.price) FROM service_request_quotes q WHERE q.service_request_id = sr.id AND q.status = 'pending') AS average_price
     FROM service_requests sr
     JOIN categories c ON c.id = sr.category_id
     JOIN users u ON u.id = sr.client_id
     WHERE sr.status = 'waiting_for_quotes' AND sr.category_id IN (${placeholders})
     ORDER BY sr.created_at DESC`,
    requestedIds
  );

  // فلترة بالمسافة: الصنايعي يشوف بس الطلبات اللي جوه نطاق SERVICE_RADIUS_KM
  // من موقعه. الصنايعي اللي مفيش له موقع محفوظ ميشوفش طلبات (لازم يحدّد موقعه).
  let requests = [];
  if (provider.current_lat != null && provider.current_lng != null) {
    requests = rows
      .map((r) => ({
        ...r,
        items: resolveOrderItems(r.category_name, r.order_details),
        distance_km:
          r.lat != null && r.lng != null
            ? Math.round(haversineKm(provider.current_lat, provider.current_lng, r.lat, r.lng) * 10) / 10
            : null,
      }))
      .filter((r) => r.distance_km != null && r.distance_km <= SERVICE_RADIUS_KM)
      .sort((a, b) => a.distance_km - b.distance_km);
  }
  return { status: 200, data: { requests, total: requests.length } };
}

async function getServiceRequestQuotes(req, query, requestId) {
  const payload = await requireAuth(req);
  const request = await db.get("SELECT * FROM service_requests WHERE id = ?", [requestId]);
  if (!request) return { status: 404, data: { error: "service_request_not_found" } };
  if (request.client_id !== payload.sub && payload.user_type !== "provider" && payload.user_type !== "both") {
    return { status: 403, data: { error: "not_authorized" } };
  }
  // بنود الطلب المختارة + اسم المهنة عشان تتعرض في قالب صفحة العروض (زي الشكل
  // اللي الصنايعي شايفه: المهنة + الوصف + البنود + العنوان).
  const requestCategory = request.category_id
    ? await db.get("SELECT name_ar FROM categories WHERE id = ?", [request.category_id])
    : null;
  const requestView = {
    ...request,
    category_name: requestCategory ? requestCategory.name_ar : null,
    items: resolveOrderItems(requestCategory ? requestCategory.name_ar : null, request.order_details),
  };

  const rawQuotes = await db.all(
    `SELECT q.*, pp.id AS provider_profile_id, u.name AS provider_name,
            pp.current_lat AS provider_lat, pp.current_lng AS provider_lng,
            pp.rating_avg AS provider_rating_avg, pp.rating_count AS provider_rating_count,
            EXISTS (
              SELECT 1 FROM provider_wallets w
              WHERE w.provider_id = pp.id AND w.unpaid_commission > 0
            ) AS provider_blocked
     FROM service_request_quotes q
     JOIN provider_profiles pp ON pp.id = q.provider_id
     JOIN users u ON u.id = pp.user_id
     WHERE q.service_request_id = ? AND q.status = 'pending'
     ORDER BY q.created_at DESC`,
    [requestId]
  );
  // مسافة كل صنايعي عن العميل (كم) عشان تتعرض تحت سعر عرضه.
  const quotes = rawQuotes.map((q) => {
    const distance_km =
      request.lat != null && request.lng != null && q.provider_lat != null && q.provider_lng != null
        ? Math.round(haversineKm(request.lat, request.lng, q.provider_lat, q.provider_lng) * 10) / 10
        : null;
    // provider_blocked بيجي 0/1 من SQLite و true/false من Postgres — نوحّده boolean
    const provider_blocked = q.provider_blocked === true || Number(q.provider_blocked) === 1;
    return { ...q, distance_km, provider_blocked };
  });
  const prices = quotes.map((q) => Number(q.price)).filter(Number.isFinite);
  const averagePrice = prices.length ? Math.round(prices.reduce((sum, value) => sum + value, 0) / prices.length * 100) / 100 : null;
  return {
    status: 200,
    data: {
      request: requestView,
      quotes,
      quote_count: quotes.length,
      average_price: averagePrice,
      lowest_price: prices.length ? Math.min(...prices) : null,
      highest_price: prices.length ? Math.max(...prices) : null,
    },
  };
}

async function submitServiceRequestQuote(req, res, body, requestId) {
  const payload = await requireAuth(req);
  requireUserType(payload, ["provider", "both"]);

  const request = await db.get("SELECT * FROM service_requests WHERE id = ?", [requestId]);
  if (!request) return { status: 404, data: { error: "service_request_not_found" } };
  if (request.status !== "waiting_for_quotes") return { status: 409, data: { error: "service_request_not_waiting_for_quotes" } };

  const provider = await db.get("SELECT * FROM provider_profiles WHERE user_id = ?", [payload.sub]);
  if (!provider) return { status: 403, data: { error: "not_a_provider" } };
  // مينفعش يقدّم عرض وهو عليه مستحقات عمولة: العرض مبيتبعتش أصلًا، فالعميل
  // مش هيشوفه ولا هيشوف عرضه — لحد ما يسدّد المستحقات من المحفظة الأول.
  const quoteBlock = await walletService.getBlockStatus(provider.id);
  if (quoteBlock.blocked) {
    return {
      status: 403,
      data: { error: "commission_unpaid", unpaid_commission: quoteBlock.unpaid_commission, threshold: quoteBlock.threshold },
    };
  }
  if (!provider.is_available) return { status: 409, data: { error: "provider_not_available" } };
  const categoryMatch = await db.get(
    "SELECT 1 FROM provider_categories WHERE provider_id = ? AND category_id = ?",
    [provider.id, request.category_id]
  );
  if (!categoryMatch) return { status: 403, data: { error: "provider_not_registered_for_category" } };

  // لو مفيش سعر محدد من الصنايعي، معناه إنه "قبل بسعر العميل" (request.price).
  // السعر بيبقى عرض بديل من الصنايعي مش بتاع العميل.
  let price = Number(body.price);
  if (!Number.isFinite(price) || price <= 0) {
    price = Number(request.price);
    if (!Number.isFinite(price) || price <= 0) {
      return { status: 400, data: { error: "positive_price_required" } };
    }
  }
  price = round2(price);
  let estimatedHours = Number(body.estimated_hours);
  if (!Number.isFinite(estimatedHours) || estimatedHours <= 0) estimatedHours = 1;
  if (body.notes && String(body.notes).length > 500) {
    return { status: 400, data: { error: "notes_too_long" } };
  }

  const id = uuid();
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO service_request_quotes
     (id, service_request_id, provider_id, price, estimated_hours, notes, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
     ON CONFLICT(service_request_id, provider_id) DO UPDATE SET
       price = excluded.price, estimated_hours = excluded.estimated_hours,
       notes = excluded.notes, status = 'pending', updated_at = excluded.updated_at`,
    [id, requestId, provider.id, price, estimatedHours, body.notes || null, now, now]
  );
  const quote = await db.get(
    "SELECT * FROM service_request_quotes WHERE service_request_id = ? AND provider_id = ?",
    [requestId, provider.id]
  );
  // العميل يستلم التحديث في شاشة انتظار العروض (بما فيهم المتوسط التقديري)
  hub.publish(`service-request:${requestId}:quotes`, { type: "quote_added", quote, request_price: request.price });
  // إشعار push للعميل إن في عرض سعر جديد وصل
  fcm.sendToUser(request.client_id, {
    title: "💬 عرض سعر جديد",
    body: `وصل عرض جديد على طلبك — ${price} ج.م`,
    data: { type: "quote_added", service_request_id: requestId },
  });
  return { status: 201, data: quote };
}

async function confirmServiceRequestQuote(req, res, body, requestId) {
  const payload = await requireAuth(req);
  if (payload.user_type !== "client" && payload.user_type !== "both") {
    return { status: 403, data: { error: "client_account_required" } };
  }

  const request = await db.get("SELECT * FROM service_requests WHERE id = ?", [requestId]);
  if (!request) return { status: 404, data: { error: "service_request_not_found" } };
  if (request.client_id !== payload.sub) return { status: 403, data: { error: "not_authorized" } };
  if (request.status !== "waiting_for_quotes") return { status: 409, data: { error: "service_request_not_waiting_for_quotes" } };

  const quote = await db.get(
    `SELECT q.*, pp.user_id AS provider_user_id
     FROM service_request_quotes q
     JOIN provider_profiles pp ON pp.id = q.provider_id
     WHERE q.id = ? AND q.service_request_id = ? AND q.status = 'pending'`,
    [body.quote_id, requestId]
  );
  if (!quote) return { status: 404, data: { error: "quote_not_found" } };

  const adjustmentSteps = Number(body.price_adjustment || 0);
  if (!Number.isInteger(adjustmentSteps) || adjustmentSteps < 0) {
    return { status: 400, data: { error: "price_adjustment_must_be_non_negative_integer" } };
  }
  const price = round2(Number(quote.price) + adjustmentSteps * 5);
  if (!price || price <= 0) return { status: 400, data: { error: "invalid_price" } };

  // الصنايعي اللي عليه مستحقات عمولة للمنصة مينفعش العميل يأكد عرضه —
  // العرض اللي بعته قبل ما تنزل عليه المستحقات (طلب اكتمل / عمولة فتح طلب)
  // ميبقاش صالح للتأكيد لحد ما يسدد، والعميل يرجع يختار غيره.
  const providerBlock = await walletService.getBlockStatus(quote.provider_id);
  if (providerBlock.blocked) {
    return {
      status: 409,
      data: {
        error: "provider_commission_unpaid",
        unpaid_commission: providerBlock.unpaid_commission,
        threshold: providerBlock.threshold,
      },
    };
  }

  // الطلب بيتعمل pending مش accepted: العميل لسه اختار الصنايعي بس،
  // والحالة الحقيقية "في انتظار قبول الصنايعي" لحد ما الصنايعي يفتح
  // شاشة "شغلانة حالية" (ساعتها يتنادى acceptOrder، بتتحسب العمولة
  // مرة واحدة، والحالة تتحول accepted).
  const orderId = uuid();
  await db.run(
    `INSERT INTO orders
     (id, client_id, provider_id, category_id, status, price, price_estimated,
      hours, hourly_rate, address_text, lat, lng, notes, order_details)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      orderId,
      payload.sub,
      quote.provider_id,
      request.category_id,
      price,
      price,
      quote.estimated_hours,
      null,
      request.address_text,
      request.lat,
      request.lng,
      request.description,
      request.order_details,
    ]
  );
  await db.run(
    `UPDATE service_requests
     SET status = 'accepted', provider_id = ?, price = ?, estimated_hours = ?, quote_id = ?, accepted_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [quote.provider_id, price, quote.estimated_hours, quote.id, requestId]
  );
  await db.run(
    `UPDATE service_request_quotes SET status = 'accepted', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [quote.id]
  );
  await db.run("INSERT INTO order_status_log (order_id, status, changed_by) VALUES (?, 'pending', ?)", [orderId, payload.sub]);
  hub.publish(`service-request:${requestId}:quotes`, { type: "quote_accepted", quote_id: quote.id, price });
  hub.publish(`order:${orderId}:tracking`, { type: "status", status: "pending", price });
  // الإعلان لبقية الصنايعية إن الطلب اترتبط بصنايعي (يتشال من قايمة المتاح)
  hub.publish(`orders:available:cat:${request.category_id}`, {
    type: "request_taken",
    service_request_id: requestId,
    provider_profile_id: quote.provider_id,
  });
  // إشعار للصنايعي اللي اترشّح — العميل اختاره، ولسه محتاج يقبل الطلب
  fcm.sendToUser(quote.provider_user_id, {
    title: "🎉 تم اختيارك",
    body: `العميل اختار عرضك — افتح "قسم الطلبات في شغلي كصنايعي" واقبل الطلب عشان تبدأ`,
    data: { type: "order_assigned", order_id: orderId },
  });
  const accepted = await db.get("SELECT * FROM service_requests WHERE id = ?", [requestId]);
  return { status: 200, data: { ...accepted, order_id: orderId, price_adjustment_steps: adjustmentSteps } };
}

// ---------------------------------------------------------------
// POST /service-requests/:id/price-bump
// العميل يزوّد سعر عرضه +5 جنيه لما المزادات كلها تكون أعلى من اللي
// عيزه — زي نظام inDrive. التحديث بيتبث لحظيًا لكل الصنايعية
// المتابعين في قناة الطلب / قناة المهنة.
// ---------------------------------------------------------------
async function bumpServiceRequestPrice(req, res, body, requestId) {
  const payload = await requireAuth(req);
  if (payload.user_type !== "client" && payload.user_type !== "both") {
    return { status: 403, data: { error: "client_account_required" } };
  }

  const request = await db.get("SELECT * FROM service_requests WHERE id = ?", [requestId]);
  if (!request) return { status: 404, data: { error: "service_request_not_found" } };
  if (request.client_id !== payload.sub) return { status: 403, data: { error: "not_authorized" } };
  if (request.status !== "waiting_for_quotes") return { status: 409, data: { error: "service_request_not_waiting_for_quotes" } };

  // كل ضغطة بتزوّد 5 جنيه
  const step = 5;
  let newPrice = Number(request.price);
  if (!Number.isFinite(newPrice) || newPrice <= 0) newPrice = 0;
  newPrice = round2(newPrice + step);

  await db.run("UPDATE service_requests SET price = ? WHERE id = ?", [newPrice, requestId]);
  const updated = await db.get("SELECT * FROM service_requests WHERE id = ?", [requestId]);
  const payloadMsg = { type: "request_price_bumped", price: newPrice, request: updated };
  hub.publish(`service-request:${requestId}:quotes`, payloadMsg);
  hub.publish(`orders:available:cat:${request.category_id}`, payloadMsg);

  return { status: 200, data: { ...updated, bumped_by: step } };
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
  createServiceRequest,
  listServiceRequests,
  availableServiceRequests,
  getServiceRequestQuotes,
  submitServiceRequestQuote,
  confirmServiceRequestQuote,
  bumpServiceRequestPrice,
};

// ---------------------------------------------------------------
// GET /providers/me — البروفايل الحالي للصنايعي (مطلوب عشان يعرف
// اسم قناة الإشعارات الخاصة بيه: provider:{id}:incoming)
// ---------------------------------------------------------------
async function getMyProvider(req) {
  const payload = await requireAuth(req);
  const provider = await db.get("SELECT * FROM provider_profiles WHERE user_id = ?", [payload.sub]);
  if (!provider) return { status: 403, data: { error: "not_a_provider" } };
  const parsedPricing = safeParseJson(provider.pricing_data);
  // كل المهن المختارة (ممكن تكون أكتر من واحدة) مع بنود التسعير
  // وأسعار كل مهنة مسطّحة بمفاتيحها الأصلية للتطبيق.
  const cats = await getProviderCategoriesWithSchema(provider.id, parsedPricing);
  provider.categories = cats;
  provider.category_ids = cats.map((c) => c.id);
  provider.category_id = cats.length ? cats[0].id : null;
  // للتوافق مع نسخ التطبيق القديمة اللي بتقرا pricing_data مسطّح لمهنة
  // واحدة بس: بنرجع أسعار أول مهنة. النسخ الجديدة بتستخدم categories.
  provider.pricing_data = cats.length ? cats[0].rates : parsedPricing;
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
    "SELECT key, name_ar, unit_ar, price, category_id FROM provider_custom_services WHERE provider_id = ? ORDER BY created_at",
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

  // المهنة اللي هتتضاف فيها الخدمة: لو الصنايعي شغال مهنة واحدة بناخدها
  // تلقائيًا (مفيش خلاف)، ولو شغال أكتر من مهنة لازم يحدد المهنة بنفسه
  // (والخانة في التطبيق بترجعله مهنه المختارة بس). null بيتسمح بس
  // للتراجع؟ لأ — null معناه خدمة عامة على كل المهن (سلوك قديم).
  const provCategories = await db.all(
    "SELECT category_id FROM provider_categories WHERE provider_id = ?",
    [provider.id]
  );
  const categoryIds = provCategories.map((r) => r.category_id);

  let categoryId = null;
  if (body.category_id != null) {
    categoryId = Number(body.category_id);
    if (!categoryIds.includes(categoryId)) {
      return { status: 400, data: { error: "invalid_category" } };
    }
  } else if (categoryIds.length === 1) {
    categoryId = categoryIds[0];
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
    "INSERT INTO provider_custom_services (provider_id, key, name_ar, unit_ar, price, category_id) VALUES (?, ?, ?, ?, ?, ?)",
    [provider.id, key, name, unit || null, price, categoryId]
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
  // من الجدول بشكل نظيف (دي المصدر الرسمي للأسماء والأسعار). بنشيل
  // الشكلين: العام القديم (custom_N) والموحّد بالمهنة (<catId>:custom_N).
  for (const k of Object.keys(rates)) {
    if (/^custom_\d+$/.test(k) || /^\d+:custom_\d+$/.test(k)) delete rates[k];
  }
  const services = await listCustomServices(providerId);
  for (const s of services) {
    // الخدمة المخصصة ليها مهنة — بتتحفظ بمفتاح موحّد بالمهنة عشان
    // تظهر للعميل في طلبات المهنة دي بس (ومتظهرش في المهنة التانية).
    if (s.category_id != null) {
      rates[`${s.category_id}:${s.key}`] = Number(s.price);
    } else {
      // توافق قديم: خدمة من غير مهنة بتفضل ظاهرة في كل المهن.
      rates[s.key] = Number(s.price);
    }
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
