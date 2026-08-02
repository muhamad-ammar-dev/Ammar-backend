// src/utils/otpStore.js
//
// تخزين مؤقت للـ OTP في الذاكرة (Map) بديل لـ Redis أثناء التطوير المحلي.
// نفس الـ interface بالظبط (set/get/del بـ TTL) — في الإنتاج تستبدلها بـ
// ioredis من غير ما تغيّر أي كود في routes/auth.js.

const store = new Map(); // key -> { value, expiresAt }
const attempts = new Map(); // key -> { count, expiresAt }

function set(key, value, ttlSeconds) {
  store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

function get(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

function del(key) {
  store.delete(key);
}

function incrAttempts(key, ttlSeconds) {
  const entry = attempts.get(key);
  if (!entry || Date.now() > entry.expiresAt) {
    attempts.set(key, { count: 1, expiresAt: Date.now() + ttlSeconds * 1000 });
    return 1;
  }
  entry.count += 1;
  return entry.count;
}

function getAttempts(key) {
  const entry = attempts.get(key);
  if (!entry || Date.now() > entry.expiresAt) return 0;
  return entry.count;
}

function resetAttempts(key) {
  attempts.delete(key);
}

module.exports = { set, get, del, incrAttempts, getAttempts, resetAttempts };
