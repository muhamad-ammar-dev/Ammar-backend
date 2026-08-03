// src/db.js
//
// طبقة قاعدة البيانات — بتستخدم node:sqlite (مدمجة في Node، مفيش npm install).
// الهدف: تقدر تشغّل المشروع فورًا للتطوير المحلي والاختبار.
//
// للإنتاج: استبدل هذا الملف بطبقة توصيل PostgreSQL (نفس التوابع بالظبط:
// run/get/all) باستخدام مكتبة `pg`، والـ schema الكامل موجود في schema.sql
// اللي اتفقنا عليه قبل كده. باقي الكود (routes) مش هيحتاج يتغير خالص لأنه
// بيستخدم الدوال دي بس، مش SQL خام مباشر.

const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");

const db = new DatabaseSync(path.join(__dirname, "..", "dev.sqlite"));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,
    phone_number    TEXT NOT NULL UNIQUE,
    name            TEXT,
    user_type       TEXT NOT NULL DEFAULT 'client', -- client | provider | both
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
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
    created_at             TEXT NOT NULL DEFAULT (datetime('now'))
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
    address_text    TEXT NOT NULL,
    lat             REAL NOT NULL,
    lng             REAL NOT NULL,
    notes           TEXT,
    cancel_reason   TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    accepted_at     TEXT,
    completed_at    TEXT,
    cancelled_at    TEXT
  );

  CREATE TABLE IF NOT EXISTS order_status_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id    TEXT NOT NULL REFERENCES orders(id),
    status      TEXT NOT NULL,
    changed_by  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS refresh_tokens (
    token       TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id),
    device_id   TEXT,
    expires_at  TEXT NOT NULL,
    revoked     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ratings (
    id            TEXT PRIMARY KEY,
    order_id      TEXT NOT NULL REFERENCES orders(id),
    rating_type   TEXT NOT NULL, -- client_to_provider | provider_to_client
    rated_by      TEXT NOT NULL REFERENCES users(id),
    rated_user    TEXT NOT NULL REFERENCES users(id),
    rating_value  INTEGER NOT NULL,
    comment       TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(order_id, rating_type)
  );

  CREATE TABLE IF NOT EXISTS order_images (
    id            TEXT PRIMARY KEY,
    order_id      TEXT NOT NULL REFERENCES orders(id),
    image_base64  TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// نضيف تخصصات مبدئية لو الجدول فاضي (بيانات تجريبية للتطوير)
const catCount = db.prepare("SELECT COUNT(*) AS c FROM categories").get().c;
if (catCount === 0) {
  const insertCat = db.prepare("INSERT INTO categories (name_ar, icon) VALUES (?, ?)");
  [["سباكة", "🔧"], ["كهرباء", "💡"], ["نجارة", "🪚"], ["دهانات", "🎨"], ["تكييف", "❄️"]]
    .forEach(([name, icon]) => insertCat.run(name, icon));
}

/** ينفذ INSERT/UPDATE/DELETE ويرجع { changes, lastInsertRowid } */
function run(sql, params = []) {
  return db.prepare(sql).run(...params);
}

/** يرجع صف واحد أو undefined */
function get(sql, params = []) {
  return db.prepare(sql).get(...params);
}

/** يرجع كل الصفوف كـ array */
function all(sql, params = []) {
  return db.prepare(sql).all(...params);
}

module.exports = { db, run, get, all };
