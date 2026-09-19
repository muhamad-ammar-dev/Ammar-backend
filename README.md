# utlob-sanaii-api

سكيلتون Backend شغال فعليًا لتطبيق "اطلب صنايعي" — بيغطي: تسجيل الدخول بـ OTP،
تفعيل وضع الصنايعي، إنشاء الطلبات، قبولها (مع حماية من الـ race condition)،
وتحديث حالتها عبر state machine.

## ليه من غير Express/pg/Redis؟

عشان تقدر تشغّله **دلوقتي على طول** من غير `npm install` (مفيش حتى حزمة
واحدة في `package.json`) وتجرب كل الـ flow بنفسك. بيستخدم بس حاجات مدمجة
في Node:
- `node:http` بدل Express
- `node:sqlite` بدل PostgreSQL
- `node:crypto` لعمل JWT بنفس فورمات `jsonwebtoken` القياسي
- Map في الذاكرة بدل Redis لتخزين الـ OTP المؤقت

الكود متقسّم بحيث كل طبقة دي (`db.js`, `otpStore.js`) لها نفس الـ interface
اللي هتحتاجه لو استبدلتها بالنسخة الحقيقية — التفاصيل تحت في قسم "الترقية
للإنتاج".

## التشغيل

```bash
node src/server.js
# أو مع auto-restart وقت التطوير
npm run dev
```

هيشتغل على `http://localhost:3000`. أول تشغيل بيعمل ملف `dev.sqlite` تلقائي
وبيزرع فيه ٥ تخصصات افتراضية (سباكة، كهرباء، نجارة، دهانات، تكييف).

> يتطلب Node.js 22.5+ (لأن `node:sqlite` تجريبي فيه). لو عندك نسخة أقدم،
> غيّر `db.js` لاستخدام `better-sqlite3` (نفس الـ API تقريبًا) بدل `node:sqlite`.

## تجربة سريعة (curl)

```bash
# 1. اطلب كود تحقق
curl -X POST localhost:3000/auth/otp \
  -H "Content-Type: application/json" \
  -d '{"phone_number":"01012345678"}'

# الكود هيتطبع في الـ terminal اللي شغال فيه السيرفر (وضع تطوير بس):
#   [DEV ONLY] OTP for +201012345678: 1234

# 2. تحقق من الكود واحصل على access_token
curl -X POST localhost:3000/auth/verify \
  -H "Content-Type: application/json" \
  -d '{"phone_number":"01012345678","otp":"1234","name":"اسمك"}'

# 3. استخدم الـ access_token في أي طلب تاني
curl localhost:3000/categories

curl -X POST localhost:3000/orders \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <التوكن>" \
  -d '{"category_id":1,"address_text":"مدينة نصر","lat":30.06,"lng":31.34}'
```

## بنية المشروع

```
src/
  server.js          # الراوتر الرئيسي — كل الـ endpoints متسجلة هنا
  db.js              # طبقة قاعدة البيانات (SQLite دلوقتي)
  middleware.js       # requireAuth / requireUserType
  utils/
    jwt.js            # sign/verify متوافق مع jsonwebtoken
    otpStore.js        # تخزين OTP مؤقت (Map بدل Redis)
    helpers.js         # uuid, validation, JSON helpers
  routes/
    auth.js            # /auth/otp, /auth/verify, /auth/refresh, /auth/logout, /auth/switch-mode
    orders.js           # /categories, /providers/nearby, /orders/*
```

## الـ Endpoints المتاحة دلوقتي

| Method | Path | ملاحظة |
|---|---|---|
| POST | /auth/otp | إرسال كود تحقق |
| POST | /auth/verify | تسجيل الدخول |
| POST | /auth/refresh | تجديد access_token |
| POST | /auth/logout | إلغاء refresh_token |
| POST | /auth/switch-mode | تفعيل/إلغاء وضع الصنايعي |
| GET | /categories | التخصصات |
| GET | /providers/nearby | صنايعية متاحين قريب (بحساب Haversine بسيط) |
| POST | /orders | إنشاء طلب |
| GET | /orders | سجل الطلبات (`?role=client\|provider`) |
| GET | /orders/:id | تفاصيل طلب |
| PATCH | /orders/:id/accept | قبول الطلب (atomic — يمنع تكرار القبول) |
| PATCH | /orders/:id/status | تحديث الحالة (state machine محكوم) |

**مش متضمن لسه** (موثّق في الملفات التانية اللي عندك، لسه محتاج تنفيذ):
تتبع الموقع اللحظي عبر WebSocket، الدفع الإلكتروني، الإشعارات الفعلية،
رفع صور التوثيق.

## الترقية للإنتاج

### 1. استبدال SQLite بـ PostgreSQL
- استخدم ملف `schema.sql` اللي عندك بالفعل (فيه الأنواع الصحيحة وUUID وENUMs).
- في `db.js`: استبدل `node:sqlite` بمكتبة `pg`، ونفّذ نفس التوابع الثلاثة
  (`run`, `get`, `all`) بحيث باقي الكود (`routes/*.js`) **ميتغيّرش خالص**.
- لاحظ فرق الـ placeholders: SQLite بيستخدم `?`، وPostgres بيستخدم `$1, $2...`
  — هتحتاج دالة تحويل بسيطة أو تستخدم مكتبة زي `pg-promise` اللي بتقبل `?`.

### 2. استبدال الـ OTP store بـ Redis
- استخدم `ioredis`، ونفّذ نفس التوابع (`set`, `get`, `del`, `incrAttempts`,
  `getAttempts`, `resetAttempts`) بنفس الأسماء.

### 3. ربط SMS gateway حقيقي
- في `routes/auth.js`، استبدل سطر الـ `console.log` بنداء حقيقي لمزود SMS
  (Vonage / SMS Misr / Twilio).

### 4. الانتقال لـ Express (اختياري)
مش إجباري — السيرفر الحالي بـ `node:http` خفيف وكافي، لكن لو عايز middleware
جاهزة (rate limiting, CORS, validation) هتلاقي الانتقال سهل لأن كل route
handler بيرجع `{status, data}` بسيط مستقل عن أي framework.

### 5. تتبع الموقع اللحظي
راجع `tracking-realtime.md` — التنفيذ المقترح فيه (Redis Pub/Sub أو Firebase)
منفصل تمامًا عن الكود الحالي، هيتضاف كـ WebSocket layer جنب السيرفر ده.

## نقاط تصميم مهمة اتاخدت في الكود

- **منع تكرار قبول الطلب**: `acceptOrder` بيستخدم `UPDATE ... WHERE status = 'pending'`
  في استعلام واحد (مش "اقرأ ثم اكتب") — ده اللي بيمنع صنايعيين يقبلوا نفس
  الطلب في نفس اللحظة.
- **State machine صارمة**: `VALID_TRANSITIONS` في `orders.js` بتمنع أي قفزة
  غير منطقية في حالة الطلب (متقدرش تروح من `pending` لـ `completed` مباشرة).
- **JWT بيتقرأ من الداتابيز وقت التجديد**: `/auth/refresh` بيجيب `user_type`
  الحالي من `users` table، مش من التوكن القديم — عشان لو حد فعّل وضع
  الصنايعي، التوكن الجديد يعكس الصلاحية الجديدة على طول.

## النشر الفعلي (الإنتاج)

### أولًا: إيميل حقيقي يوصّل الكود لأي إيميل
1. سجّل في **Brevo** (https://brevo.com) — باقة مجانية 300 إيميل/يوم من غير كارت.
2. اعمل حساب *منصة* → لوح التحكم → **Sender Identity** → أضف إيميلك المرسل
   وفعّله (هيبعتولك رسالة تأكيد).
3. **SMTP & API → API Keys** → اعمل `Master Key` وانسخه.

### تانيًا: ارفع السيرفر + قاعدة البيانات
- أسهل طريقة: استخدم `render.yaml` (Blueprints على Render). اربط الـ repo
  بـ Render وخلاص — هيشتغل web service + قاعدة PostgreSQL تلقائيًا.
- أو يدويًا على أي استضافة:
  - `DATABASE_URL` → PostgreSQL connection string
  - `NODE_ENV=production`
  - `MAIL_PROVIDER=brevo` + `BREVO_API_KEY` + `BREVO_FROM_EMAIL`
  - `ADMIN_KEY` → نفس المفتاح اللي هتكتبه في التطبيق لشاشة الإدارة
- كل المتغيرات موثقة في `.env.example`.

### تالتًا: التطبيق
- في التطبيق: **الإعدادات → عنوان السيرفر** → اكتب
  `https://utlob-sanaii-api.onrender.com` (أو أي عنوان استضافتك) → حفظ.
- بعدها سجّل خروج وادخل تاني، أو اعمل تثبيت جديد للتطبيق.

### ملاحظات الإنتاج
- لو استخدامك لـ SMS لاحقًا: فعّل `SMS_PROVIDER=smsmisr` وضع مفاتيحه في
  `.env` / إعدادات الخدمة.
- بيانات قاعدة البيانات بتفضل محفوظة على Postgres — مش SQLite اللي بيتفشخ
  مع كل إعادة تشغيل على الاستضافات المجانية.
- الـ OTP بيتخزن في الذاكرة/Redis مش في الداتابيز — لو استضفت بـ Redis
  حط `REDIS_URL`.
