// src/db.js
//
// طبقة قاعدة البيانات — وضعين بنفس الواجهة بالظبط (كلها async):
//   run(sql, params)          -> { changes, lastInsertRowid }
//   get(sql, params)          -> صف واحد أو undefined
//   all(sql, params)          -> مصفوفة صفوف
//   getSetting(key, fallback) -> قيمة إعداد منصة أو fallback
//   setSetting(key, value)    -> يكتب/يحدّث إعداد منصة
//   db.run/get/all            -> نفس الدوال على كائن واحد
//   ready                     -> Promise، اتأكد منه قبل أول استعلام
//   close()                   -> يغلق الاتصال (للسكربتات والاختبارات)
//
// الوضعين:
//   1) PostgreSQL (الإنتاج): لو DATABASE_URL متظبط، بنستخدم `pg` مع
//      connection pool + schema جاهز في schema.pg.sql (بيتعمل تلقائيًا).
//   2) SQLite (التطوير المحلي): لو DATABASE_URL مش موجود، بنستخدم
//      node:sqlite (مدمجة في Node 22+) من غير أي تثبيت.
//
// الـ SQL في الـ routes مكتوب بشكل متوافق مع الاتنين:
//   CURRENT_TIMESTAMP بدل datetime('now')  و  ON CONFLICT بدل INSERT OR IGNORE
// ولو شغالين على Postgres، علامات الاستفهام (?) بتتحول لـ $1, $2, ... تلقائيًا.

const path = require("node:path");
const fs = require("node:fs");

const { DATABASE_URL } = process.env;

// ---------------------------------------------------------------
// وضع PostgreSQL — الإنتاج
// ---------------------------------------------------------------
if (DATABASE_URL) {
  const { Pool, types } = require("pg");

  // pg بيرجع numeric/int8/float كنصوص افتراضيًا — نحافظ على الأرقام أرقامًا
  // عشان شكل الـ API يفضل زي SQLite بالظبط.
  types.setTypeParser(20, (v) => Number(v)); // int8
  types.setTypeParser(701, parseFloat); // float8
  types.setTypeParser(700, parseFloat); // float4
  types.setTypeParser(1700, parseFloat); // numeric

  // HTTPS على استضافات السحابة غالبًا إجباري. لوكال Docker: PG_SSL=false
  const useSsl =
    process.env.PG_SSL === "true" ||
    /[?&]sslmode=require/.test(DATABASE_URL) ||
    /[?&]ssl=true/.test(DATABASE_URL);

  const pool = new Pool({
    connectionString: DATABASE_URL,
    max: Number(process.env.PG_POOL_MAX) || 10,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
  });

  function toParams(sql, params) {
    let i = 0;
    return {
      text: sql.replace(/\?/g, () => "$" + ++i),
      values: params || [],
    };
  }

  async function run(sql, params = []) {
    const res = await pool.query(toParams(sql, params));
    return { changes: res.rowCount ?? 0, lastInsertRowid: 0 };
  }

  async function get(sql, params = []) {
    const res = await pool.query(toParams(sql, params));
    return res.rows[0];
  }

  async function all(sql, params = []) {
    const res = await pool.query(toParams(sql, params));
    return res.rows;
  }

  async function getSetting(key, fallback = null) {
    const row = await get("SELECT value FROM platform_settings WHERE key = ?", [key]);
    return row ? row.value : fallback;
  }

  async function setSetting(key, value) {
    await run(
      "INSERT INTO platform_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, String(value)]
    );
  }

  const db = { run, get, all };

  // تشغيل schema الإنتاجية + البيانات الافتراضية عند أول اتصال
  async function init() {
    const schemaPath = path.join(__dirname, "..", "schema.pg.sql");
    const ddl = fs.readFileSync(schemaPath, "utf8");
    for (const statement of ddl.split(";")) {
      const sql = statement.trim();
      if (sql) await pool.query(sql);
    }

    const settingDefaults = {
      commission_percent: "10",
      unpaid_threshold: "100",
      payout_instapay: "",
      payout_vodafone: "",
      payout_paypal: "",
    };
    for (const [key, value] of Object.entries(settingDefaults)) {
      const exists = await get("SELECT 1 FROM platform_settings WHERE key = ?", [key]);
      if (!exists) await run("INSERT INTO platform_settings (key, value) VALUES (?, ?)", [key, value]);
    }

    // ترحيلات أعمدة للجداول الموجودة (Postgres يضيف العمود لجدول جديد فقط)
    await run("ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TEXT");
    await run("ALTER TABLE orders ADD COLUMN IF NOT EXISTS hidden_from_client INTEGER NOT NULL DEFAULT 0");
    await run("ALTER TABLE orders ADD COLUMN IF NOT EXISTS hidden_from_provider INTEGER NOT NULL DEFAULT 0");
    await run("ALTER TABLE orders ADD COLUMN IF NOT EXISTS commission_charged_at TEXT");

    const catCount = await get("SELECT COUNT(*)::int AS c FROM categories");
    if (Number(catCount.c) === 0) {
      const seed = [
        ["سباك", "🔧"],
        ["كهربائي", "💡"],
        ["نجار", "🪚"],
        ["نقاش", "🎨"],
        ["تكييف", "❄️"],
        ["بناء وواجهات حجرية", "🧱"],
        ["سيراميك", "🀄"],
        ["باركيه", "🪵"],
        ["حداد", "🔨"],
        ["محارة", "🏗️"],
        ["رخام وجرانيت", "🪨"],
        ["جبسيوم بورد", "🧰"],
        ["جبس بلدي ومصيص", "🏛️"],
        ["ستائر وتنجيد", "🛋️"],
        ["زجاج وسيكوريت", "🪟"],
        ["الوميتال", "🚪"],
        ["نقل اثاث", "🚚"],
        ["استرجي", "🧵"],
        ["ونش تشوين", "🏗️"],
        ["تركيب كرانيش فوم", "🖼️"],
        ["صيانة دش", "📡"],
        ["مكافحة حشرات وقوارض", "🐜"],
        ["حمامات سباحة", "🏊"],
        ["صيانة اجهزة منزلية", "🧺"],
      ];
      for (const [name, icon] of seed) {
        await run("INSERT INTO categories (name_ar, icon) VALUES (?, ?)", [name, icon]);
      }
    }
  }

  const ready = init().catch((err) => {
    console.error("[db] فشل الاتصال بـ PostgreSQL:", err.message);
    throw err;
  });

  function close() {
    return pool.end();
  }

  module.exports = { mode: "postgres", db, run, get, all, getSetting, setSetting, ready, close };
} else {
  // ---------------------------------------------------------------
  // وضع SQLite — التطوير المحلي (node:sqlite، مفيش npm install)
  // ---------------------------------------------------------------
  const { DatabaseSync } = require("node:sqlite");

  const sqlite = new DatabaseSync(path.join(__dirname, "..", "dev.sqlite"));

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id              TEXT PRIMARY KEY,
      phone_number    TEXT NOT NULL UNIQUE,
      email           TEXT,
      name            TEXT,
      avatar          TEXT,
      user_type       TEXT NOT NULL DEFAULT 'client', -- client | provider | both
      is_active       INTEGER NOT NULL DEFAULT 1,
      deleted_at      TEXT,
      created_at      TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      updated_at      TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );

    CREATE TABLE IF NOT EXISTS provider_profiles (
      id                    TEXT PRIMARY KEY,
      user_id               TEXT NOT NULL UNIQUE REFERENCES users(id),
      national_id_verified  INTEGER NOT NULL DEFAULT 0,
      service_radius_km     REAL NOT NULL DEFAULT 5.0,
      is_available          INTEGER NOT NULL DEFAULT 0,
      current_lat           REAL,
      current_lng           REAL,
      location_updated_at   TEXT,
      rating_avg             REAL NOT NULL DEFAULT 0,
      rating_count            INTEGER NOT NULL DEFAULT 0,
      jobs_completed         INTEGER NOT NULL DEFAULT 0,
      hourly_rate            REAL NOT NULL DEFAULT 0,
      created_at             TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );

    CREATE TABLE IF NOT EXISTS categories (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      name_ar   TEXT NOT NULL,
      icon      TEXT
    );

    CREATE TABLE IF NOT EXISTS provider_categories (
      provider_id TEXT NOT NULL REFERENCES provider_profiles(id),
      category_id INTEGER NOT NULL REFERENCES categories(id),
      PRIMARY KEY (provider_id, category_id)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id              TEXT PRIMARY KEY,
      client_id       TEXT NOT NULL REFERENCES users(id),
      provider_id     TEXT REFERENCES provider_profiles(id),
      category_id     INTEGER NOT NULL REFERENCES categories(id),
      status          TEXT NOT NULL DEFAULT 'pending',
      price_estimated NUMERIC,
      price_final     NUMERIC,
      price           NUMERIC,
      hours           NUMERIC,
      hourly_rate     NUMERIC,
      commission_percent     NUMERIC,
      commission_amount      NUMERIC,
      commission_charged_at  TEXT,
      address_text    TEXT NOT NULL,
      lat             REAL NOT NULL,
      lng             REAL NOT NULL,
      notes           TEXT,
      cancel_reason   TEXT,
      created_at      TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      accepted_at     TEXT,
      completed_at    TEXT,
      cancelled_at    TEXT
    );

    CREATE TABLE IF NOT EXISTS order_status_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id    TEXT NOT NULL REFERENCES orders(id),
      status      TEXT NOT NULL,
      changed_by  TEXT,
      created_at  TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      token       TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id),
      device_id   TEXT,
      expires_at  TEXT NOT NULL,
      revoked     INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );

    CREATE TABLE IF NOT EXISTS ratings (
      id            TEXT PRIMARY KEY,
      order_id      TEXT NOT NULL REFERENCES orders(id),
      rating_type   TEXT NOT NULL, -- client_to_provider | provider_to_client
      rated_by      TEXT NOT NULL REFERENCES users(id),
      rated_user    TEXT NOT NULL REFERENCES users(id),
      rating_value  INTEGER NOT NULL,
      comment       TEXT,
      created_at    TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      UNIQUE(order_id, rating_type)
    );

    CREATE TABLE IF NOT EXISTS order_images (
      id            TEXT PRIMARY KEY,
      order_id      TEXT NOT NULL REFERENCES orders(id),
      image_base64  TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );

    CREATE TABLE IF NOT EXISTS platform_settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS provider_wallets (
      id                TEXT PRIMARY KEY,
      provider_id       TEXT NOT NULL UNIQUE REFERENCES provider_profiles(id),
      total_earned      NUMERIC NOT NULL DEFAULT 0,
      total_commission  NUMERIC NOT NULL DEFAULT 0,
      unpaid_commission NUMERIC NOT NULL DEFAULT 0,
      pending_withdrawal NUMERIC NOT NULL DEFAULT 0,
      total_withdrawn   NUMERIC NOT NULL DEFAULT 0,
      updated_at        TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );

    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id         TEXT PRIMARY KEY,
      wallet_id  TEXT NOT NULL REFERENCES provider_wallets(id),
      kind       TEXT NOT NULL, -- earnings | commission | payment
      amount     NUMERIC NOT NULL,
      order_id   TEXT,
      note       TEXT,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );

    -- خدمات مخصصة بيضيفها الصنايعي بنفسه (اسم + وحدة + سعر) فوق
    -- البنود الإجبارية بتاعة مهنته — كل صنايعي ليه الخدمات بتاعته.
    CREATE TABLE IF NOT EXISTS provider_custom_services (
      provider_id TEXT NOT NULL REFERENCES provider_profiles(id),
      key         TEXT NOT NULL,
      name_ar     TEXT NOT NULL,
      unit_ar     TEXT,
      price       NUMERIC NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      PRIMARY KEY (provider_id, key)
    );

    CREATE TABLE IF NOT EXISTS commission_payments (
      id           TEXT PRIMARY KEY,
      provider_id  TEXT NOT NULL REFERENCES provider_profiles(id),
      amount       NUMERIC NOT NULL,
      method       TEXT NOT NULL, -- instapay | vodafone | paypal | cash
      status       TEXT NOT NULL DEFAULT 'pending_confirmation',
      note         TEXT,
      created_at   TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      confirmed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS device_tokens (
      token      TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id),
      platform   TEXT NOT NULL DEFAULT 'android',
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );
  `);

  // أعمدة إضافية للـ DB المحلي القديم (بيتضافوا بالتدريج من غير مسح بيانات)
  function addColumn(table, column, definition) {
    try {
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch (_) {
      // العمود موجود بالفعل — نتجاهل
    }
  }
  addColumn("orders", "price", "NUMERIC");
  addColumn("orders", "commission_percent", "NUMERIC");
  addColumn("orders", "commission_amount", "NUMERIC");
  addColumn("orders", "hours", "NUMERIC");
  addColumn("orders", "hourly_rate", "NUMERIC");
  addColumn("provider_profiles", "hourly_rate", "REAL NOT NULL DEFAULT 0");
  // أسعار الصنايعي الخاصة بمهنته (JSON: {item_key: سعر الوحدة}) — من src/pricing.js
  addColumn("provider_profiles", "pricing_data", "TEXT");
  // الكميات اللي دخلها العميل في تفاصيل الطلب (JSON: {item_key: كمية})
  addColumn("orders", "order_details", "TEXT");
  addColumn("users", "avatar", "TEXT");
  addColumn("users", "email", "TEXT");
  addColumn("users", "deleted_at", "TEXT");
  addColumn("orders", "hidden_from_client", "INTEGER DEFAULT 0");
  addColumn("orders", "hidden_from_provider", "INTEGER DEFAULT 0");
  // أول تفاعل (فتح الطلب أو قبوله) اللي سجّل عمولة المنصة على الطلب ده
  addColumn("orders", "commission_charged_at", "TEXT");

  // إعدادات المنصة الافتراضية
  const settingDefaults = {
    commission_percent: "10",
    unpaid_threshold: "100",
    payout_instapay: "",
    payout_vodafone: "",
    payout_paypal: "",
  };
  for (const [key, value] of Object.entries(settingDefaults)) {
    const exists = sqlite.prepare("SELECT 1 FROM platform_settings WHERE key = ?").get(key);
    if (!exists) sqlite.prepare("INSERT INTO platform_settings (key, value) VALUES (?, ?)").run(key, value);
  }

  // التخصصات المبدئية لو الجدول فاضي
  const catCount = sqlite.prepare("SELECT COUNT(*) AS c FROM categories").get().c;
  if (catCount === 0) {
    const insertCat = sqlite.prepare("INSERT INTO categories (name_ar, icon) VALUES (?, ?)");
    [
      ["سباك", "🔧"],
      ["كهربائي", "💡"],
      ["نجار", "🪚"],
      ["نقاش", "🎨"],
      ["تكييف", "❄️"],
      ["بناء وواجهات حجرية", "🧱"],
      ["سيراميك", "🀄"],
      ["باركيه", "🪵"],
      ["حداد", "🔨"],
      ["محارة", "🏗️"],
      ["رخام وجرانيت", "🪨"],
      ["جبسيوم بورد", "🧰"],
      ["جبس بلدي ومصيص", "🏛️"],
      ["ستائر وتنجيد", "🛋️"],
      ["زجاج وسيكوريت", "🪟"],
      ["الوميتال", "🚪"],
      ["نقل اثاث", "🚚"],
      ["استرجي", "🧵"],
      ["ونش تشوين", "🏗️"],
      ["تركيب كرانيش فوم", "🖼️"],
      ["صيانة دش", "📡"],
      ["مكافحة حشرات وقوارض", "🐜"],
      ["حمامات سباحة", "🏊"],
      ["صيانة اجهزة منزلية", "🧺"],
    ].forEach(([name, icon]) => insertCat.run(name, icon));
  }

  async function run(sql, params = []) {
    return sqlite.prepare(sql).run(...params);
  }

  async function get(sql, params = []) {
    return sqlite.prepare(sql).get(...params);
  }

  async function all(sql, params = []) {
    return sqlite.prepare(sql).all(...params);
  }

  async function getSetting(key, fallback = null) {
    const row = sqlite.prepare("SELECT value FROM platform_settings WHERE key = ?").get(key);
    return row ? row.value : fallback;
  }

  async function setSetting(key, value) {
    sqlite
      .prepare(
        "INSERT INTO platform_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(key, String(value));
  }

  const db = { run, get, all };
  const ready = Promise.resolve();

  function close() {
    sqlite.close();
    return Promise.resolve();
  }

  module.exports = { mode: "sqlite", db, run, get, all, getSetting, setSetting, ready, close };
}
