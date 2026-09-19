// src/utils/storage.js
//
// رفع الصور على Supabase Storage (المجاني) بدل تخزينها base64 جوه قاعدة
// البيانات — ده أهم فرق بين قاعدة تستحمل مئات وقاعدة تستحمل آلافًا وملايين:
// القاعدة تحتفظ بالرابط بس (نص صغير)، والصور تتوزع من CDN سريع.
//
// متغيرات البيئة (كلها من مشروع Supabase مجاني):
//   SUPABASE_URL          مثال: https://xxxxx.supabase.co
//   SUPABASE_SERVICE_KEY  مفتاح service_role (سرّي جدًا — ميتبعتش للعميل أبدًا)
//   SUPABASE_BUCKET       اختياري — افتراضيًا "media" (لازم يكون Public bucket)
//
// لو المتغيرات مش متظبطة (زي التطوير المحلي)، الدوال بترجع null والسيرفر
// بيرجع تلقائيًا للسلوك القديم (تخزين الصورة نصًا) — يعني مفيش حاجة بتتكسر.

const { uuid } = require("./helpers");

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const BUCKET = process.env.SUPABASE_BUCKET || "media";

const enabled = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);

function contentTypeFor(ext) {
  switch (ext) {
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return "image/jpeg";
  }
}

/**
 * بيرفع data URL (data:image/jpeg;base64,....) على Supabase Storage
 * ويرجّع الرابط العام. لو الخدمة مش متظبطة أو حصل خطأ بيرجع null.
 * [folder] مجلد تنظيمي داخل البكت ("orders" أو "avatars").
 */
async function uploadDataUrl(dataUrl, folder = "misc") {
  if (!enabled || typeof dataUrl !== "string") return null;
  const match = /^data:[^;]+;base64,(.+)$/s.exec(dataUrl);
  if (!match) return null;

  let buffer;
  try {
    buffer = Buffer.from(match[1], "base64");
  } catch (_) {
    return null;
  }

  const extMatch = /^data:image\/(jpeg|jpg|png|webp|gif)/i.exec(dataUrl);
  const ext = extMatch ? extMatch[1].toLowerCase() : "jpg";
  const path = `${folder}/${uuid()}.${ext}`;

  try {
    const res = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          "Content-Type": contentTypeFor(ext),
          "x-upsert": "false",
        },
        body: new Uint8Array(buffer),
      }
    );
    if (!res.ok) {
      const body = await res.text();
      console.error("[storage] فشل رفع الصورة:", res.status, body.slice(0, 200));
      return null;
    }
    return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
  } catch (err) {
    console.error("[storage] خطأ في رفع الصورة:", err.message);
    return null;
  }
}

/**
 * مسح صورة قديمة من البكت بأفضل جهد — لو الرابط مش من تخزيننا أو حصل
 * خطأ، بنتجاهل بصمت لأن المسح مش جزء أساسي من أي عملية.
 */
async function deletePublicUrl(publicUrl) {
  if (!enabled || typeof publicUrl !== "string") return;
  const prefix = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/`;
  if (!publicUrl.startsWith(prefix)) return;
  const path = publicUrl.slice(prefix.length);
  try {
    await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    });
  } catch (_) {
    // تجاهل — المسح best-effort
  }
}

module.exports = { enabled, uploadDataUrl, deletePublicUrl };
