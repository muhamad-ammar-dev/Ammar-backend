// src/utils/otpStore.js
//
// تخزين مؤقت للـ OTP والـ rate limiting — وضعين بنفس الواجهة (كلها async):
//   set(key, value, ttlSeconds)
//   get(key)                  -> value أو null
//   del(key)
//   incrAttempts(key, ttlSeconds) -> العداد بعد الزيادة
//   getAttempts(key)          -> العداد الحالي أو 0
//   resetAttempts(key)
//
// الوضعين:
//   1) Redis (الإنتاج): لو REDIS_URL متظبط، بنستخدم ioredis — عشان الـ
//      rate limiting والتخزين يشتغلوا صح حتى مع أكتر من سيرفر backend.
//   2) الذاكرة (التطوير المحلي): Map جوه العملية — نفس اللي قبل كده.
//
// ملاحظة: لو مفيش Redis واشتغلت أكتر من نسخة من السيرفر، كل نسخة هيكون
// ليها عدادات منفصلة — مشكلة للإنتاج بس، ولذلك لازم REDIS_URL في الإنتاج.

const { REDIS_URL } = process.env;

if (REDIS_URL) {
  const Redis = require("ioredis");

  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });

  async function set(key, value, ttlSeconds) {
    await redis.set(key, value, "EX", ttlSeconds);
  }

  async function get(key) {
    const v = await redis.get(key);
    return v;
  }

  async function del(key) {
    await redis.del(key);
  }

  async function incrAttempts(key, ttlSeconds) {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, ttlSeconds);
    return count;
  }

  async function getAttempts(key) {
    const v = await redis.get(key);
    return v ? Number(v) : 0;
  }

  async function resetAttempts(key) {
    await redis.del(key);
  }

  function close() {
    return redis.quit();
  }

  module.exports = {
    mode: "redis",
    set,
    get,
    del,
    incrAttempts,
    getAttempts,
    resetAttempts,
    close,
  };
} else {
  // ---------------------------------------------------------------
  // وضع الذاكرة المحلية (تطوير)
  // ---------------------------------------------------------------
  const store = new Map(); // key -> { value, expiresAt }
  const attempts = new Map(); // key -> { count, expiresAt }

  async function set(key, value, ttlSeconds) {
    store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async function get(key) {
    const entry = store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      store.delete(key);
      return null;
    }
    return entry.value;
  }

  async function del(key) {
    store.delete(key);
  }

  async function incrAttempts(key, ttlSeconds) {
    const entry = attempts.get(key);
    if (!entry || Date.now() > entry.expiresAt) {
      attempts.set(key, { count: 1, expiresAt: Date.now() + ttlSeconds * 1000 });
      return 1;
    }
    entry.count += 1;
    return entry.count;
  }

  async function getAttempts(key) {
    const entry = attempts.get(key);
    if (!entry || Date.now() > entry.expiresAt) return 0;
    return entry.count;
  }

  async function resetAttempts(key) {
    attempts.delete(key);
  }

  module.exports = {
    mode: "memory",
    set,
    get,
    del,
    incrAttempts,
    getAttempts,
    resetAttempts,
  };
}
