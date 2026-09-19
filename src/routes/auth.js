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
const { sendOtp } = require("../utils/sms");
const { sendOtpEmail } = require("../utils/mailer");
const { verifyIdToken } = require("../utils/firebaseIdToken");

const OTP_TTL_SECONDS = 300; // 5 دقايق
const OTP_MAX_REQUESTS_PER_WINDOW = 3;
const DELETE_GRACE_DAYS = 30;
const DELETE_GRACE_MS = DELETE_GRACE_DAYS * 24 * 3600 * 1000;
const OTP_REQUEST_WINDOW_SECONDS = 600; // 10 دقايق
const OTP_MAX_VERIFY_ATTEMPTS = 5;
const OTP_VERIFY_LOCK_SECONDS = 900; // 15 دقيقة

// في التطوير ممكن ننظطيب DEV_OTP لثبيت كود معين — بس
// في الإنتاج (NODE_ENV=production) بنرفضه خالصاً عشان ميفضلش
// "باب خلفي" كود كردة اصلحة يفتح لكل أرقام.
function devOtpCode() {
  if (process.env.NODE_ENV === "production") return null;
  return process.env.DEV_OTP || null;
}

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
  const requestCount = await otpStore.incrAttempts(rateLimitKey, OTP_REQUEST_WINDOW_SECONDS);
  if (requestCount > OTP_MAX_REQUESTS_PER_WINDOW) {
    return { status: 429, data: { error: "too_many_requests", retry_after: OTP_REQUEST_WINDOW_SECONDS } };
  }

  // في التطوير: بنستخدم DEV_OTP ثابت لو متظبط (أسهل للاختبار المحلي)،
  // وإلا بنولّد كود عشوائي. في الإنتاج بيتبعت SMS حقيقي.
  const code = devOtpCode() || generateOtp();
  await otpStore.set(`otp:${phone}`, code, OTP_TTL_SECONDS);

  // في الإنتاج: هنا بيتم استدعاء SMS gateway حقيقي (Vonage / SMS Misr...).
  // في التطوير: بنطبع الكود في الـ console عشان تقدر تكمل الفلو محليًا.
  try {
    await sendOtp(phone, code);
  } catch (err) {
    // SMS provider failed - keep the OTP valid and log the error.
    console.error("[OTP] SMS send failed:", err && err.message ? err.message : err);
  }

  return { status: 200, data: { message: "OTP sent", expires_in: OTP_TTL_SECONDS } };
}

// ---------------------------------------------------------------
// بحث/إنشاء مستخدم برقم الموبايل — منطق مشترك بين OTP السيرفر و Firebase.
// بيرجّع { user, isNewUser } بعد تطبيق قواعد "فترة السماح" (الاسترجاع/الحذف).
// ---------------------------------------------------------------
async function findOrCreateUserByPhone(phone, name) {
  let user = await db.get("SELECT * FROM users WHERE phone_number = ?", [phone]);
  let isNewUser = false;

  if (!user) {
    const id = uuid();
    await db.run(
      "INSERT INTO users (id, phone_number, name, user_type, is_active) VALUES (?, ?, ?, 'client', 1)",
      [id, phone, name || null]
    );
    user = await db.get("SELECT * FROM users WHERE id = ?", [id]);
    isNewUser = true;
  } else if (!user.is_active) {
    // الحساب متقفل (طلب حذف أو تعطيل). لو الحذف لسه جوه فترة الـ30 يوم
    // بنرجع الحساب زي ما هو بدل ما نعمل حساب جديد — "الاسترجاع".
    if (user.deleted_at) {
      const deletedAt = new Date(user.deleted_at).getTime();
      if (Date.now() - deletedAt < DELETE_GRACE_MS) {
        // الحساب لسه جوه فترة السماح — بنرجعه زي ما هو. المهن
        // وبيانات الصنايعي فضلوا في قواعد البيانات (من غير ما نمسحهم).
        await db.run(
          "UPDATE users SET is_active = 1, deleted_at = NULL, name = COALESCE(?, name), updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          [name || null, user.id]
        );
        // بنعيد جلب البيانات عشان التطبيق يحصل على is_active=1
        // بدل ما يفضل شايف is_active=0 (بيانات قديمة).
        user = await db.get("SELECT * FROM users WHERE id = ?", [user.id]);
      } else {
        // فترة السماح خلصت — الحذف النهائي: بنقفل الحساب نهائيًا ونعمل
        // حساب جديد برقم الموبايل ده. البيانات القديمة بتتوه بتمويه الرقم.
        await permanentlyDeleteUser(user.id);
        const id = uuid();
        await db.run(
          "INSERT INTO users (id, phone_number, name, user_type, is_active) VALUES (?, ?, ?, 'client', 1)",
          [id, phone, name || null]
        );
        user = await db.get("SELECT * FROM users WHERE id = ?", [id]);
        isNewUser = true;
      }
    } else {
      // حساب معطّل من غير deleted_at (زي حساب البريد الإلكتروني المدمج)
      // — بنرجعه عادي زي ما كان.
      await db.run("UPDATE users SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [user.id]);
      user = await db.get("SELECT * FROM users WHERE id = ?", [user.id]);
    }
  }

  return { user, isNewUser };
}

// ---------------------------------------------------------------
// POST /auth/verify
// ---------------------------------------------------------------
async function verifyOtp(req, res, body) {
  const { phone_number, otp, name } = body;
  if (!phone_number || !otp) {
    return { status: 400, data: { error: "phone_number_and_otp_required" } };
  }
  // الاسم إجباري عند تسجيل الدخول/التسجيل — مفيش حساب من غير اسم.
  if (!String(name || "").trim()) {
    return { status: 400, data: { error: "name_required" } };
  }
  const phone = normalizePhone(phone_number);

  const lockKey = `otp_lock:${phone}`;
  if (await otpStore.getAttempts(lockKey) >= OTP_MAX_VERIFY_ATTEMPTS) {
    return { status: 429, data: { error: "too_many_failed_attempts", retry_after: OTP_VERIFY_LOCK_SECONDS } };
  }

  const storedOtp = await otpStore.get(`otp:${phone}`);
  if (!storedOtp || storedOtp !== otp) {
    const attempts = await otpStore.incrAttempts(lockKey, OTP_VERIFY_LOCK_SECONDS);
    return {
      status: 400,
      data: { error: "invalid_otp", attempts_remaining: Math.max(0, OTP_MAX_VERIFY_ATTEMPTS - attempts) },
    };
  }

  await otpStore.del(`otp:${phone}`);
  await otpStore.resetAttempts(lockKey);

  const { user, isNewUser } = await findOrCreateUserByPhone(phone, name);

  const accessToken = jwt.sign({ sub: user.id, user_type: user.user_type }, 3600);
  const refreshToken = uuid();
  const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  await db.run(
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
        avatar: user.avatar,
        phone_number: user.phone_number,
        user_type: user.user_type,
        is_new_user: isNewUser,
      },
    },
  };
}

// ---------------------------------------------------------------
// POST /auth/firebase
// ---------------------------------------------------------------
// تسجيل الدخول عبر Firebase Phone Auth: التطبيق بيبعث الـ ID token
// الصادر من Firebase (بعد ما المستخدم أكّد الكود)، والسيرفر بيصدّقه
// يدويًا (من غير firebase-admin) ويبني/يلاقي حساب التطبيق ويرجع نفس
// شكل الرد بتاع /auth/verify بالظبط.
async function verifyFirebaseToken(req, res, body) {
  const { id_token, phone_number, name } = body;
  if (!id_token) {
    return { status: 400, data: { error: "id_token_required" } };
  }
  // الاسم إجباري هنا كمان — نفس قاعدة تسجيل الدخول برقم الموبايل.
  if (!String(name || "").trim()) {
    return { status: 400, data: { error: "name_required" } };
  }

  let claims;
  try {
    claims = await verifyIdToken(id_token);
  } catch (err) {
    if (err.message === "firebase_not_configured") {
      return { status: 500, data: { error: "firebase_not_configured" } };
    }
    return { status: 401, data: { error: "invalid_id_token" } };
  }

  // Firebase بيحط رقم الموبايل المؤكَّد في الـ claims بصيغة دولية
  // (+20...). لو مش موجود يبقى التوكن مش من تسجيل دخول برقم موبايل.
  const claimPhone = claims.phone_number;
  if (!claimPhone) {
    return { status: 400, data: { error: "phone_sign_in_required" } };
  }
  const phone = normalizePhone(claimPhone);
  if (!isValidEgyptianPhone(phone)) {
    return { status: 400, data: { error: "invalid_phone_number" } };
  }

  // تأمين إضافي: الرقم اللي اتبعت من التطبيق لازم يطابق الرقم المصدَّق
  // من Firebase نفسه — عشان محدش يكتب رقم حد تاني في الـ body.
  if (phone_number && normalizePhone(String(phone_number)) !== phone) {
    return { status: 400, data: { error: "phone_number_mismatch" } };
  }

  const { user, isNewUser } = await findOrCreateUserByPhone(phone, name);

  const accessToken = jwt.sign({ sub: user.id, user_type: user.user_type }, 3600);
  const refreshToken = uuid();
  const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  await db.run(
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
        avatar: user.avatar,
        phone_number: user.phone_number,
        user_type: user.user_type,
        is_new_user: isNewUser,
      },
    },
  };
}

// ---------------------------------------------------------------
// POST /auth/email/otp — إرسال كود تحقق على الإيميل
// ---------------------------------------------------------------
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

async function requestEmailOtp(req, res, body) {
  const email = String(body.email || "").trim().toLowerCase();
  if (!isValidEmail(email)) {
    return { status: 400, data: { error: "invalid_email" } };
  }

  const rateLimitKey = `email_otp_requests:${email}`;
  const requestCount = await otpStore.incrAttempts(rateLimitKey, OTP_REQUEST_WINDOW_SECONDS);
  if (requestCount > OTP_MAX_REQUESTS_PER_WINDOW) {
    return { status: 429, data: { error: "too_many_requests", retry_after: OTP_REQUEST_WINDOW_SECONDS } };
  }

  const code = devOtpCode() || generateOtp();
  await otpStore.set(`email_otp:${email}`, code, OTP_TTL_SECONDS);

  try {
    await sendOtpEmail(email, code);
  } catch (err) {
    console.error("[OTP] EMAIL send failed:", err && err.message ? err.message : err);
  }

  return { status: 200, data: { message: "OTP sent", expires_in: OTP_TTL_SECONDS } };
}

// ---------------------------------------------------------------
// POST /auth/email/verify — تأكيد كود الإيميل وإنشاء/دخول المستخدم
// ---------------------------------------------------------------
async function verifyEmailOtp(req, res, body) {
  const email = String(body.email || "").trim().toLowerCase();
  const { otp, name } = body;
  if (!isValidEmail(email) || !otp) {
    return { status: 400, data: { error: "email_and_otp_required" } };
  }
  // الاسم إجباري — نفس قاعدة تسجيل الدخول برقم الموبايل.
  if (!String(name || "").trim()) {
    return { status: 400, data: { error: "name_required" } };
  }

  // رقم الموبايل إجباري في تسجيل الإيميل (العميل/الصنايعي) لأنه بيُستخدم
  // جوه التطبيق (اتصالات، تواصل) — بس الكود بيتبعته على الإيميل مش SMS.
  let phone = null;
  if (body.phone_number) {
    if (!isValidEgyptianPhone(String(body.phone_number))) {
      return { status: 400, data: { error: "invalid_phone_number" } };
    }
    phone = normalizePhone(String(body.phone_number));
  }

  const lockKey = `email_otp_lock:${email}`;
  if (await otpStore.getAttempts(lockKey) >= OTP_MAX_VERIFY_ATTEMPTS) {
    return { status: 429, data: { error: "too_many_failed_attempts", retry_after: OTP_VERIFY_LOCK_SECONDS } };
  }

  const storedOtp = await otpStore.get(`email_otp:${email}`);
  if (!storedOtp || storedOtp !== otp) {
    const attempts = await otpStore.incrAttempts(lockKey, OTP_VERIFY_LOCK_SECONDS);
    return {
      status: 400,
      data: { error: "invalid_otp", attempts_remaining: Math.max(0, OTP_MAX_VERIFY_ATTEMPTS - attempts) },
    };
  }

  await otpStore.del(`email_otp:${email}`);
  await otpStore.resetAttempts(lockKey);

  let user = await db.get("SELECT * FROM users WHERE email = ?", [email]);
  const phoneUser = phone ? await db.get("SELECT * FROM users WHERE phone_number = ?", [phone]) : null;
  let isNewUser = false;

  if (!user) {
    if (!phone) {
      return { status: 400, data: { error: "phone_number_required" } };
    }
    if (phoneUser) {
      // نفس الشخص سجّل قبل كده برقم الموبايل — نربط الإيميل بنفس الحساب
      // ونكمل دخول بدل ما نحطّل المستخدم برسالة خطأ.
      await db.run(
        "UPDATE users SET email = ?, name = COALESCE(?, name), updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [email, name || null, phoneUser.id]
      );
      user = await db.get("SELECT * FROM users WHERE id = ?", [phoneUser.id]);
    } else {
      const id = uuid();
      await db.run(
        "INSERT INTO users (id, phone_number, email, name, user_type, is_active) VALUES (?, ?, ?, ?, 'client', 1)",
        [id, phone, email, name || null]
      );
      user = await db.get("SELECT * FROM users WHERE id = ?", [id]);
      isNewUser = true;
    }
  } else if (!phone) {
    // مستخدم موجود بالإيميل: الرقم لسه إجباري لأنه بيُستخدم للتواصل جوه التطبيق
    return { status: 400, data: { error: "phone_number_required" } };
  } else if (!phoneUser) {
    // حساب الإيميل موجود والرقم جديد — نضيف الرقم للحساب
    await db.run(
      "UPDATE users SET phone_number = ?, name = COALESCE(?, name), updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [phone, name || null, user.id]
    );
    user = await db.get("SELECT * FROM users WHERE id = ?", [user.id]);
  } else if (phoneUser.id === user.id) {
    // نفس الحساب — نفس الرقم ونفس الإيميل
    user = phoneUser;
  } else {
    // الإيميل على حساب والرقم على حساب تاني. لو حساب الإيميل ده اتعمل بالفلّو
    // القديم (رقمه placeholder زي "email_...") بندمجه في حساب الرقم؛ غير كده
    // ده تعارض حقيقي بين حسابين.
    if (String(user.phone_number || "").startsWith("email_")) {
      await db.run(
        "UPDATE users SET is_active = 0, email = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [user.id]
      );
      await db.run("UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?", [user.id]);
      await db.run(
        "UPDATE users SET email = ?, name = COALESCE(?, name), updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [email, name || null, phoneUser.id]
      );
      user = await db.get("SELECT * FROM users WHERE id = ?", [phoneUser.id]);
    } else {
      return { status: 400, data: { error: "phone_number_already_used" } };
    }
  }

  if (!user.is_active) {
    // حساب متقفل — نفس منطق "فترة السماح" بتاع رقم الموبايل: لو لسه
    // جوه الـ30 يوم بنرجعه، ولو خلصت بنحذفه نهائيًا وندفع بحساب جديد.
    if (user.deleted_at) {
      const deletedAt = new Date(user.deleted_at).getTime();
      if (Date.now() - deletedAt < DELETE_GRACE_MS) {
        await db.run(
          "UPDATE users SET is_active = 1, deleted_at = NULL, name = COALESCE(?, name), updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          [name || null, user.id]
        );
        user = await db.get("SELECT * FROM users WHERE id = ?", [user.id]);
      } else {
        await permanentlyDeleteUser(user.id);
        const id = uuid();
        await db.run(
          "INSERT INTO users (id, phone_number, email, name, user_type, is_active) VALUES (?, ?, ?, ?, 'client', 1)",
          [id, phone, email, name || null]
        );
        user = await db.get("SELECT * FROM users WHERE id = ?", [id]);
        isNewUser = true;
      }
    } else {
      await db.run("UPDATE users SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [user.id]);
      user = await db.get("SELECT * FROM users WHERE id = ?", [user.id]);
    }
  }

  const accessToken = jwt.sign({ sub: user.id, user_type: user.user_type }, 3600);
  const refreshToken = uuid();
  const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  await db.run(
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
        avatar: user.avatar,
        email: user.email,
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

  const row = await db.get("SELECT * FROM refresh_tokens WHERE token = ?", [refresh_token]);
  if (!row || row.revoked || new Date(row.expires_at) < new Date()) {
    return { status: 401, data: { error: "invalid_refresh_token" } };
  }

  const user = await db.get("SELECT * FROM users WHERE id = ?", [row.user_id]);
  if (!user || !user.is_active) {
    return { status: 401, data: { error: "invalid_refresh_token" } };
  }
  const accessToken = jwt.sign({ sub: user.id, user_type: user.user_type }, 3600);
  return { status: 200, data: { access_token: accessToken, expires_in: 3600 } };
}

// ---------------------------------------------------------------
// POST /auth/logout
// ---------------------------------------------------------------
async function logout(req, res, body) {
  await requireAuth(req); // يتأكد إن فيه access token صالح
  const { refresh_token } = body;
  if (refresh_token) {
    await db.run("UPDATE refresh_tokens SET revoked = 1 WHERE token = ?", [refresh_token]);
  }
  return { status: 200, data: { message: "logged_out" } };
}

// ---------------------------------------------------------------
// POST /auth/switch-mode
// ---------------------------------------------------------------
async function switchMode(req, res, body) {
  const payload = await requireAuth(req);
  const { enable_provider_mode } = body;

  const user = await db.get("SELECT * FROM users WHERE id = ?", [payload.sub]);
  if (!user) return { status: 404, data: { error: "user_not_found" } };

  if (enable_provider_mode) {
    let profile = await db.get("SELECT * FROM provider_profiles WHERE user_id = ?", [user.id]);
    if (!profile) {
      const id = uuid();
      await db.run(
        "INSERT INTO provider_profiles (id, user_id, national_id_verified, is_available) VALUES (?, ?, 0, 0)",
        [id, user.id]
      );
      profile = await db.get("SELECT * FROM provider_profiles WHERE id = ?", [id]);
    }
    await db.run("UPDATE users SET user_type = 'both', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [user.id]);
    return {
      status: 200,
      data: {
        user_type: "both",
        provider_profile_id: profile.id,
        verification_required: !profile.national_id_verified,
      },
    };
  }

  await db.run("UPDATE users SET user_type = 'client', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [user.id]);
  return { status: 200, data: { user_type: "client" } };
}

// ---------------------------------------------------------------
// PATCH /users/me — تعديل الاسم و/أو صورة البروفايل
// ---------------------------------------------------------------
async function updateProfile(req, res, body) {
  const payload = await requireAuth(req);
  const { name } = body;
  const hasName = name !== undefined && name !== null;
  const hasAvatar = body.avatar !== undefined;
  const hasPhone = body.phone_number !== undefined && body.phone_number !== null;

  if (!hasName && !hasAvatar && !hasPhone) {
    return { status: 400, data: { error: "nothing_to_update" } };
  }
  if (hasName && !String(name).trim()) {
    return { status: 400, data: { error: "name_required" } };
  }

  // تغيير رقم الموبايل: لازم يكون رقم مصري صحيح وغير مستخدم على حساب
  // تاني (بنرفض حتى لو الحساب التاني متقفل — عشان مايحصلش تعارض في
  // الاسترجاع خلال فترة السماح).
  let normalizedPhone = null;
  if (hasPhone) {
    const rawPhone = String(body.phone_number).trim();
    if (!isValidEgyptianPhone(rawPhone)) {
      return { status: 400, data: { error: "invalid_phone_number" } };
    }
    normalizedPhone = normalizePhone(rawPhone);
    const taken = await db.get(
      "SELECT id FROM users WHERE phone_number = ? AND id != ?",
      [normalizedPhone, payload.sub]
    );
    if (taken) {
      return { status: 400, data: { error: "phone_number_already_used" } };
    }
  }

  const updates = [];
  const params = [];
  if (hasName) {
    updates.push("name = ?");
    params.push(String(name).trim());
  }
  if (hasAvatar) {
    // الصورة الجديدة (data URL) بترفع على Supabase Storage وبتتخزن
    // كرابط في القاعدة — null معناه حذف الصورة. لو التخزين مش متظبط
    // (تطوير محلي) بنخزن الـ data URL زي ما هو.
    let avatarValue = body.avatar === null ? null : String(body.avatar);
    if (avatarValue && avatarValue.startsWith("data:image")) {
      const uploaded = await require("../utils/storage").uploadDataUrl(avatarValue, "avatars");
      if (uploaded) {
        avatarValue = uploaded;
      }
    }
    // نمسح الصورة القديمة من التخزين بأفضل جهد لو كانت مرفوعة عندنا
    try {
      const oldUser = await db.get("SELECT avatar FROM users WHERE id = ?", [payload.sub]);
      if (oldUser && oldUser.avatar) await require("../utils/storage").deletePublicUrl(String(oldUser.avatar));
    } catch (_) {
      // تجاهل — المسح best-effort ومش مسموح يبوظ عملية التحديث
    }
    updates.push("avatar = ?");
    params.push(avatarValue);
  }
  if (hasPhone) {
    updates.push("phone_number = ?");
    params.push(normalizedPhone);
  }
  updates.push("updated_at = CURRENT_TIMESTAMP");
  await db.run(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`, [...params, payload.sub]);

  const user = await db.get("SELECT id, name, phone_number, user_type, avatar FROM users WHERE id = ?", [payload.sub]);
  return { status: 200, data: { user } };
}

// ---------------------------------------------------------------
// DELETE /users/me — طلب حذف الحساب
// ---------------------------------------------------------------
// بيفعّل "فترة سماح" 30 يوم: الحساب بيقفل فورًا (مش بيمشي تاني في
// أي استعلامات)، لكن رقم الموبايل وباقي البيانات بتتفضل محفوظة
// عشان لو المستخدم سجّل دخول بنفس الرقم خلال الـ30 يوم يرجع حسابه
// زي ما هو. بعد الـ30 يوم الحذف النهائي بيتنفذ (تمويه البيانات
// ومسح كل السجلات الشخصية) من غير ما نكسر علاقات الطلبات التاريخية.
async function deleteAccount(req, res, body) {
  const payload = await requireAuth(req);
  // مبنمسحش provider_categories هنا — لأن provider اللي is_active=0
  // مش بيظهر في أي استعلام أصلًا (nearbyProviders بيفلتر على u.is_active=1).
  // لو المستخدم سجّل تاني خلال 30 يوم، مهنه وهويته هيفضلوا موجودين.
  // الحذف النهائي بعد 30 يوم (permanentlyDeleteUser) هو اللي بيمسح كل حاجة.
  await db.run("DELETE FROM refresh_tokens WHERE user_id = ?", [payload.sub]);
  await db.run("DELETE FROM device_tokens WHERE user_id = ?", [payload.sub]);
  await db.run("UPDATE users SET is_active = 0, deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [payload.sub]);
  return { status: 200, data: { message: "account_deletion_scheduled", delete_after_days: DELETE_GRACE_DAYS } };
}

// ---------------------------------------------------------------
// الحذف النهائي بعد انتهاء فترة السماح — بيتموّه كل البيانات الشخصية
// عشان الحساب ميفضلش قابل للاسترجاع، بس بنحافظ على الـ id عشان علاقات
// الطلبات والتقييمات التاريخية (foreign keys) تفضل سليمة.
// ---------------------------------------------------------------
async function permanentlyDeleteUser(userId) {
  const provider = await db.get("SELECT * FROM provider_profiles WHERE user_id = ?", [userId]);
  if (provider) {
    await db.run("DELETE FROM provider_categories WHERE provider_id = ?", [provider.id]);
  }
  await db.run("DELETE FROM refresh_tokens WHERE user_id = ?", [userId]);
  await db.run("DELETE FROM device_tokens WHERE user_id = ?", [userId]);
  await db.run(
    "UPDATE users SET is_active = 0, deleted_at = deleted_at, phone_number = phone_number || '_deleted_' || id, email = NULL, avatar = NULL, name = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [userId]
  );
}

// ---------------------------------------------------------------
// وظيفة دورية — بتتنادى من السيرفر كل مدة، وبتمسح نهائيًا أي حسابات
// عدّى عليها فترة السماح (30 يوم) من طلب الحذف.
// ---------------------------------------------------------------
async function purgeExpiredDeletions(now = Date.now()) {
  const rows = await db.all(
    "SELECT id, deleted_at FROM users WHERE is_active = 0 AND deleted_at IS NOT NULL"
  );
  let purged = 0;
  for (const row of rows) {
    const deletedAt = new Date(row.deleted_at).getTime();
    if (now - deletedAt >= DELETE_GRACE_MS) {
      await permanentlyDeleteUser(row.id);
      purged++;
    }
  }
  return purged;
}

module.exports = { requestOtp, verifyOtp, verifyFirebaseToken, requestEmailOtp, verifyEmailOtp, refresh, logout, switchMode, updateProfile, deleteAccount, purgeExpiredDeletions };
