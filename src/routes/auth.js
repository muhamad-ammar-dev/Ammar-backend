// src/routes/auth.js
//
// تنفيذ مطابق لملف auth-endpoints.md اللي اتفقنا عليه.

const db = require("../db");
const jwt = require("../utils/jwt");
const otpStore = require("../utils/otpStore");
const { requireAuth } = require("../middleware");
const {
  uuid,
  isValidEgyptianPhone,
  normalizePhone,
  generateOtp,
} = require("../utils/helpers");

const OTP_TTL_SECONDS = 300; // 5 دقايق
const OTP_MAX_REQUESTS_PER_WINDOW = 3;
const OTP_REQUEST_WINDOW_SECONDS = 600; // 10 دقايق
const OTP_MAX_VERIFY_ATTEMPTS = 5;
const OTP_VERIFY_LOCK_SECONDS = 900; // 15 دقيقة

// ---------------------------------------------------------------
// POST /auth/otp
// ---------------------------------------------------------------
async function requestOtp(req, res, body) {
  const { phone_number } = body;

  if (!phone_number || !isValidEgyptianPhone(phone_number)) {
    return { status: 400, data: { error: "invalid_phone_number" } };
  }
  const phone = normalizePhone(phone_number);

  const rateLimitKey = `otp_requests:${phone}`;
  const requestCount = otpStore.incrAttempts(rateLimitKey, OTP_REQUEST_WINDOW_SECONDS);
  if (requestCount > OTP_MAX_REQUESTS_PER_WINDOW) {
    return { status: 429, data: { error: "too_many_requests", retry_after: OTP_REQUEST_WINDOW_SECONDS } };
  }

  const code = generateOtp();
  otpStore.set(`otp:${phone}`, code, OTP_TTL_SECONDS);

  // في الإنتاج: هنا بيتم استدعاء SMS gateway حقيقي (Vonage / SMS Misr...).
  // في التطوير: بنطبع الكود في الـ console عشان تقدر تكمل الفلو محليًا.
  console.log(`[DEV ONLY] OTP for ${phone}: ${code}`);

  return { status: 200, data: { message: "OTP sent", expires_in: OTP_TTL_SECONDS } };
}

// ---------------------------------------------------------------
// POST /auth/verify
// ---------------------------------------------------------------
async function verifyOtp(req, res, body) {
  const { phone_number, otp, name } = body;
  if (!phone_number || !otp) {
    return { status: 400, data: { error: "phone_number_and_otp_required" } };
  }
  const phone = normalizePhone(phone_number);

  const lockKey = `otp_lock:${phone}`;
  if (otpStore.getAttempts(lockKey) >= OTP_MAX_VERIFY_ATTEMPTS) {
    return { status: 429, data: { error: "too_many_failed_attempts", retry_after: OTP_VERIFY_LOCK_SECONDS } };
  }

  const storedOtp = otpStore.get(`otp:${phone}`);
  if (!storedOtp || storedOtp !== otp) {
    const attempts = otpStore.incrAttempts(lockKey, OTP_VERIFY_LOCK_SECONDS);
    return {
      status: 400,
      data: { error: "invalid_otp", attempts_remaining: Math.max(0, OTP_MAX_VERIFY_ATTEMPTS - attempts) },
    };
  }

  otpStore.del(`otp:${phone}`);
  otpStore.resetAttempts(lockKey);

  let user = db.get("SELECT * FROM users WHERE phone_number = ?", [phone]);
  let isNewUser = false;

  if (!user) {
    const id = uuid();
    db.run(
      "INSERT INTO users (id, phone_number, name, user_type, is_active) VALUES (?, ?, ?, 'client', 1)",
      [id, phone, name || null]
    );
    user = db.get("SELECT * FROM users WHERE id = ?", [id]);
    isNewUser = true;
  } else if (!user.is_active) {
    db.run("UPDATE users SET is_active = 1, updated_at = datetime('now') WHERE id = ?", [user.id]);
  }

  const accessToken = jwt.sign({ sub: user.id, user_type: user.user_type }, 3600);
  const refreshToken = uuid();
  const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  db.run(
    "INSERT INTO refresh_tokens (token, user_id, expires_at, revoked) VALUES (?, ?, ?, 0)",
    [refreshToken, user.id, expiresAt]
  );

  return {
    status: 200,
    data: {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600,
      user: {
        id: user.id,
        name: user.name,
        phone_number: user.phone_number,
        user_type: user.user_type,
        is_new_user: isNewUser,
      },
    },
  };
}

// ---------------------------------------------------------------
// POST /auth/refresh
// ---------------------------------------------------------------
async function refresh(req, res, body) {
  const { refresh_token } = body;
  if (!refresh_token) return { status: 400, data: { error: "refresh_token_required" } };

  const row = db.get("SELECT * FROM refresh_tokens WHERE token = ?", [refresh_token]);
  if (!row || row.revoked || new Date(row.expires_at) < new Date()) {
    return { status: 401, data: { error: "invalid_refresh_token" } };
  }

  const user = db.get("SELECT * FROM users WHERE id = ?", [row.user_id]);
  const accessToken = jwt.sign({ sub: user.id, user_type: user.user_type }, 3600);
  return { status: 200, data: { access_token: accessToken, expires_in: 3600 } };
}

// ---------------------------------------------------------------
// POST /auth/logout
// ---------------------------------------------------------------
async function logout(req, res, body) {
  requireAuth(req); // يتأكد إن فيه access token صالح
  const { refresh_token } = body;
  if (refresh_token) {
    db.run("UPDATE refresh_tokens SET revoked = 1 WHERE token = ?", [refresh_token]);
  }
  return { status: 200, data: { message: "logged_out" } };
}

// ---------------------------------------------------------------
// POST /auth/switch-mode
// ---------------------------------------------------------------
async function switchMode(req, res, body) {
  const payload = requireAuth(req);
  const { enable_provider_mode } = body;

  const user = db.get("SELECT * FROM users WHERE id = ?", [payload.sub]);
  if (!user) return { status: 404, data: { error: "user_not_found" } };

  if (enable_provider_mode) {
    let profile = db.get("SELECT * FROM provider_profiles WHERE user_id = ?", [user.id]);
    if (!profile) {
      const id = uuid();
      db.run(
        "INSERT INTO provider_profiles (id, user_id, national_id_verified, is_available) VALUES (?, ?, 0, 0)",
        [id, user.id]
      );
      profile = db.get("SELECT * FROM provider_profiles WHERE id = ?", [id]);
    }
    db.run("UPDATE users SET user_type = 'both', updated_at = datetime('now') WHERE id = ?", [user.id]);
    return {
      status: 200,
      data: {
        user_type: "both",
        provider_profile_id: profile.id,
        verification_required: !profile.national_id_verified,
      },
    };
  }

  db.run("UPDATE users SET user_type = 'client', updated_at = datetime('now') WHERE id = ?", [user.id]);
  return { status: 200, data: { user_type: "client" } };
}

module.exports = { requestOtp, verifyOtp, refresh, logout, switchMode };
