# دليل نشر "اطلب صنايعي" — مجانًا بالكامل 🚀

المنصة كلها بتشتغل على الخطط المجانية، ومهيأة تستحمل **آلاف المستخدمين**
(مش ملايين — الملايين محتاجة خطط مدفوعة زي ما شرحنا). الاتنين الأساس:

| الخدمة | بتعمل إيه | التكلفة |
|---|---|---|
| [Supabase](https://supabase.com) | قاعدة البيانات (Postgres) + تخزين الصور | مجاني |
| [Render](https://render.com) | تشغيل السيرفر (API) | مجاني |
| UptimeRobot / cron-job.org | إبقاء السيرفر صاحي | مجاني |

---

## 1️⃣ إنشاء مشروع Supabase (قاعدة + صور في حساب واحد)

1. اعمل حساب جديد على https://supabase.com واضغط **New project**.
2. اختار Region قريب (مثلاً `Frankfurt`)، وحط Password لقاعدة البيانات
   (**احتفظ بيه** — هنحتاجه تحت).
3. استنى دقيقة للمشروع يجهز.

### أ) جيب رابط قاعدة البيانات

من **Project Settings → Database → Connection string → URI**، هتلاقي شكل:
```
postgresql://postgres.[المعرّف]:[PASSWORD]@aws-0-[region].pooler.supabase.com:6543/postgres
```
- بدّل `[PASSWORD]` بالباسورد اللي حفظته.
- ده هو الـ `DATABASE_URL` بتاعنا.
- ✅ مش محتاج تنفذ أي SQL بإيدك — أول مرة السيرفر يشتغل بيعمل الجداول تلقائيًا.

> 💡 لو حابب تتأكد بنفسك: افتح **SQL Editor** في Supabase والصق محتوى
> `schema.pg.sql` وشغّله. آمن لأن كل الأوامر `IF NOT EXISTS`.

### ب) جهّز مخزن الصور

1. من القائمة الجانبية: **Storage → New bucket**.
2. اسم البكت: `media`
3. ✅ علّم على **Public bucket** (عشان روابط الصور تشتغل من غير تواقيع).

### ج) جيب مفاتيح المشروع

من **Project Settings → API**:
- `Project URL` ← ده `SUPABASE_URL`
- `service_role key` (تحت secret) ← ده `SUPABASE_SERVICE_KEY`

⚠️ **مهم جدًا:** مفتاح service_role سرّي تمامًا — بيتبعت للسيرفر بس،
عمرك ما تحطه في كود التطبيق أو تشاركه مع حد.

---

## 2️⃣ نشر السيرفر على Render

1. ارفع فولدر السيرفر (`backend - Copy`) على GitHub repo خاص بيه.
2. من Render: **New → Blueprint** واختار الـ repo — هيقرا `render.yaml`
   ويعمل Web Service + قاعدة تلقائيًا.

   > ملحوظة: قاعدة Render المجانية بتنتهي بعد 30 يوم — عشان كده بنستخدم
   > Supabase للقاعدة. لو Render سألك، اعمل Web Service عادي (New → Web Service)
   > واستخدم الإعدادات اللي تحت وإلغِ سطر `fromDatabase` من render.yaml.

3. بعد إنشاء الخدمة، روح **Environment** واضبط المتغيرات دي:

| المتغير | القيمة |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | رابط Supabase من خطوة 1-أ |
| `SUPABASE_URL` | رابط المشروع من خطوة 1-ج |
| `SUPABASE_SERVICE_KEY` | مفتاح service_role من خطوة 1-ج |
| `SUPABASE_BUCKET` | `media` |
| `JWT_SECRET` | سيبه فاضي — Render بيولّده لوحده |
| `BREVO_API_KEY` | مفتاح Brevo بتاعك (لإيميلات OTP) |
| `BREVO_FROM_EMAIL` | إيميل الإرسال المعتمد في Brevo |
| `ADMIN_KEY` | أي نص طويل عشوائي (سرّي — للوحة الأدمن) |
| `FIREBASE_SERVICE_ACCOUNT_B64` | ملف `firebase-service-account.json` متحوّل لـ base64 (عشان إشعارات FCM — شرح تحت) |

4. اضغط **Save** — هيعمل deploy. أول تشغيل بيعمل الجداول لوحده.

### تفعيل إشعارات الدفع (FCM) 🔔

بدون المتغير ده السيرفر **مش بيبعت إشعارات** (بيتجاهلها بصمت —
`fcm_not_configured`). عشان تفعّله:

1. محليًا في فولدر السيرفر، ولّد القيمة (سطر واحد طويل):
   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes('firebase-service-account.json'))
   ```
2. في Render: افتح خدمتك → **Environment** → **Add Environment Variable**:
   - Key: `FIREBASE_SERVICE_ACCOUNT_B64`
   - Value: الصق الـ base64 اللي طلع من الخطوة 1
3. **Save** → **Manual Deploy** → **Deploy latest commit**.
4. تأكد: افتح `https://[اسم-خدمتك].onrender.com/health`
   - `"fcm_configured": true` يبقى الإشعارات شغالة ✅
   - لو `false` يبقى المتغير ناقص أو غلط.

### التأكد إن كله تمام

افتح في المتصفح: `https://[اسم-خدمتك].onrender.com/health`
لو رجّع `{"status":"ok"}` (وصحبها `fcm_configured`) يبقى السيرفر + القاعدة شغالين. 🎉

لو عايز تتأكد من القاعدة لوحدها، عندك محليًا:
```bash
DATABASE_URL="رابط-supabase" npm run db:init
```
المفروض يطبع `[db] جاهزة (postgres)`.

---

## 3️⃣ إبقاء السيرفر صاحي (مهم!)

الخطة المجانية على Render بتُنام السيرفر بعد 15 دقيقة من غير استخدام
(أول طلب بعدها بياخد ~50 ثانية). الحل المجاني:

1. اعمل حساب على https://uptimemonitor.com أو https://cron-job.org
2. اعمل Monitor/Job جديد يزور:
   ```
   https://[اسم-خدمتك].onrender.com/health
   ```
   كل **5 دقايق**.

كده السيرفر صاحي 24 ساعة ومستخدميك عمرهم ما يحسوا ببطء.

---

## 4️⃣ تطبيق الموبايل

- الرابط الرسمي للسيرفر متظبط جوه التطبيق في وضع الإنتاج
  (`lib/services/api_service.dart`) — مش محتاج تغير حاجة.
- اعمل نسخة النشر زي ما تعمل دايمًا: `flutter build apk --release`.
- إشعارات Firebase (FCM) شغالة بنفس الإعداد الحالي — مفيش تغيير.

---

## ⚠️ تنبيهات مهمة قبل الإطلاق

1. **متضيفش `DEV_OTP`** في متغيرات البيئة على Render نهائيًا — ده للاختبار
   المحلي بس (بيعرض كود OTP في اللوج بدل إرساله فعليًا).
2. **حدود الخطط المجانية** (كفاية لبداية قوية):
   - Supabase: قاعدة 500MB + تخزين صور 1GB + 5GB نقل شهريًا.
   - Render: 750 ساعة تشغيل شهريًا.
   - لو اقتربت من الحدود، الترقية لأرخص خطة مدفوعة في Supabase (~$25)
     هتفتحلك سقف الملايين.
3. **نسخة احتياطية**: من Supabase: Database → Backups (مفعلة تلقائيًا).
4. لو غيّرت أي حاجة في `schema.pg.sql` بعد ما الناس بدأت تستخدم التطبيق،
   استخدم `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` بس — عمرك ما تمسح أعمدة.

---

## 🔧 إيه اللي اتغير تقنيًا؟ (ملخص)

- **القاعدة**: نفس كود السيرفر بيشتغل SQLite محليًا للتطوير، وبيلتقط
  PostgreSQL تلقائيًا أول ما `DATABASE_URL` يظهر — صفر تعديل في الكود.
- **الصور**: بدل ما تتخزن base64 جوه القاعدة (وده كان هيخنقها)، بتترفع
  على Supabase Storage والقاعدة بتحتفظ بالرابط بس. التطبيق بيعرض
  الروابط والـ base64 القديم (للتوافق مع الصور الموجودة).
- **التوسع الأفقي**: لو زاد الحمل مستقبلًا، ممكن تضيف `REDIS_URL` (مجاني
  من Upstash) لتوزيع الجلسات والإشعارات على أكثر من نسخة سيرفر — الكود
  جاهز ليها.
