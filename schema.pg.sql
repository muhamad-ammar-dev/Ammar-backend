-- schema.pg.sql
--
-- Schema قاعدة البيانات الإنتاجية (PostgreSQL). بيتشغّل تلقائيًا أول ما
-- السيرفر يشتغل وDATABASE_URL متظبط (بتفرض على نفس شكل بيانات SQLite
-- المحلية: تواريخ TEXT، أعلام INTEGER 1/0 — عشان الـ API يفضل زي ما هو).
--
-- ملاحظة للإنتاج الحقيقي على نطاق كبير:
--   * صور البروفايل وصور الطلبات بتتخزن حاليًا كـ base64 في الجداول
--     (image_base64 / users.avatar). قبل النطاق الكبير جداً، انقلهم
--     لـ S3/Cloudinary وخزّن الرابط بس.
--   * حساب "الصنايعية القريبين" هيتحسن بتحويله لـ PostGIS (earthdistance).

-- ============ الجداول الأساسية ============

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  phone_number TEXT NOT NULL UNIQUE,
  email        TEXT,
  name         TEXT,
  avatar       TEXT,
  user_type    TEXT NOT NULL DEFAULT 'client', -- client | provider | both
  is_active    INTEGER NOT NULL DEFAULT 1,
  deleted_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- بريد إضافي للحسابات القديمة اللي اتعملت قبل عمود الإيميل
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (email) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS provider_profiles (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL UNIQUE REFERENCES users(id),
  national_id_verified INTEGER NOT NULL DEFAULT 0,
  service_radius_km    DOUBLE PRECISION NOT NULL DEFAULT 5.0,
  is_available         INTEGER NOT NULL DEFAULT 0,
  current_lat          DOUBLE PRECISION,
  current_lng          DOUBLE PRECISION,
  location_updated_at  TEXT,
  rating_avg           DOUBLE PRECISION NOT NULL DEFAULT 0,
  rating_count         INTEGER NOT NULL DEFAULT 0,
  jobs_completed       INTEGER NOT NULL DEFAULT 0,
  hourly_rate          DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS categories (
  id      BIGSERIAL PRIMARY KEY,
  name_ar TEXT NOT NULL,
  icon    TEXT
);

CREATE TABLE IF NOT EXISTS provider_categories (
  provider_id TEXT NOT NULL REFERENCES provider_profiles(id),
  category_id BIGINT NOT NULL REFERENCES categories(id),
  PRIMARY KEY (provider_id, category_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id                 TEXT PRIMARY KEY,
  client_id          TEXT NOT NULL REFERENCES users(id),
  provider_id        TEXT REFERENCES provider_profiles(id),
  category_id        BIGINT NOT NULL REFERENCES categories(id),
  status             TEXT NOT NULL DEFAULT 'pending',
  price_estimated    NUMERIC,
  price_final        NUMERIC,
  price              NUMERIC,
  hours              NUMERIC,
  hourly_rate        NUMERIC,
  commission_percent NUMERIC,
  commission_amount  NUMERIC,
  commission_charged_at TEXT,
  address_text       TEXT NOT NULL,
  lat                DOUBLE PRECISION NOT NULL,
  lng                DOUBLE PRECISION NOT NULL,
  notes              TEXT,
  cancel_reason      TEXT,
  created_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accepted_at        TEXT,
  completed_at       TEXT,
  cancelled_at       TEXT,
  hidden_from_client INTEGER NOT NULL DEFAULT 0,
  hidden_from_provider INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS order_status_log (
  id         BIGSERIAL PRIMARY KEY,
  order_id   TEXT NOT NULL REFERENCES orders(id),
  status     TEXT NOT NULL,
  changed_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  device_id  TEXT,
  expires_at TEXT NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ratings (
  id           TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL REFERENCES orders(id),
  rating_type  TEXT NOT NULL, -- client_to_provider | provider_to_client
  rated_by     TEXT NOT NULL REFERENCES users(id),
  rated_user   TEXT NOT NULL REFERENCES users(id),
  rating_value INTEGER NOT NULL,
  comment      TEXT,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (order_id, rating_type)
);

CREATE TABLE IF NOT EXISTS order_images (
  id           TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL REFERENCES orders(id),
  image_base64 TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS platform_settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS provider_wallets (
  id                 TEXT PRIMARY KEY,
  provider_id        TEXT NOT NULL UNIQUE REFERENCES provider_profiles(id),
  total_earned       NUMERIC NOT NULL DEFAULT 0,
  total_commission   NUMERIC NOT NULL DEFAULT 0,
  unpaid_commission  NUMERIC NOT NULL DEFAULT 0,
  pending_withdrawal NUMERIC NOT NULL DEFAULT 0,
  total_withdrawn    NUMERIC NOT NULL DEFAULT 0,
  updated_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id         TEXT PRIMARY KEY,
  wallet_id  TEXT NOT NULL REFERENCES provider_wallets(id),
  kind       TEXT NOT NULL, -- earnings | commission | payment
  amount     NUMERIC NOT NULL,
  order_id   TEXT,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- خدمات مخصصة بيضيفها الصنايعي بنفسه (اسم + وحدة + سعر) فوق
-- البنود الإجبارية بتاعة مهنته — كل صنايعي ليه الخدمات بتاعته.
CREATE TABLE IF NOT EXISTS provider_custom_services (
  provider_id TEXT NOT NULL REFERENCES provider_profiles(id),
  key         TEXT NOT NULL,
  name_ar     TEXT NOT NULL,
  unit_ar     TEXT,
  price       NUMERIC NOT NULL,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (provider_id, key)
);

CREATE TABLE IF NOT EXISTS commission_payments (
  id           TEXT PRIMARY KEY,
  provider_id  TEXT NOT NULL REFERENCES provider_profiles(id),
  amount       NUMERIC NOT NULL,
  method       TEXT NOT NULL, -- instapay | vodafone | paypal | cash
  status       TEXT NOT NULL DEFAULT 'pending_confirmation',
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  confirmed_at TEXT
);

CREATE TABLE IF NOT EXISTS device_tokens (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  platform   TEXT NOT NULL DEFAULT 'android',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============ الفهارس (performance) ============

-- أعمدة جديدة للـ DB القديم (من غير مسح بيانات)
ALTER TABLE provider_profiles ADD COLUMN IF NOT EXISTS hourly_rate DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS hours NUMERIC;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC;
-- أسعار الصنايعي الخاصة بمهنته + كميات العميل في تفاصيل الطلب (JSON)
ALTER TABLE provider_profiles ADD COLUMN IF NOT EXISTS pricing_data TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_details TEXT;

CREATE INDEX IF NOT EXISTS idx_users_phone ON users (phone_number);
CREATE INDEX IF NOT EXISTS idx_profiles_availability ON provider_profiles (is_available);
CREATE INDEX IF NOT EXISTS idx_profiles_location ON provider_profiles (current_lat, current_lng);
CREATE INDEX IF NOT EXISTS idx_provider_cats_category ON provider_categories (category_id);

CREATE INDEX IF NOT EXISTS idx_orders_client ON orders (client_id);
CREATE INDEX IF NOT EXISTS idx_orders_provider ON orders (provider_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_category ON orders (category_id);

CREATE INDEX IF NOT EXISTS idx_status_log_order ON order_status_log (order_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_ratings_rated ON ratings (rated_user, rating_type);
CREATE INDEX IF NOT EXISTS idx_order_images_order ON order_images (order_id);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_wallet ON wallet_transactions (wallet_id);
CREATE INDEX IF NOT EXISTS idx_commission_payments_provider ON commission_payments (provider_id);
CREATE INDEX IF NOT EXISTS idx_commission_payments_status ON commission_payments (status);
CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens (user_id);
