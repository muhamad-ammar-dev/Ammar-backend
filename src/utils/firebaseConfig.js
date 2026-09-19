// src/utils/firebaseConfig.js
//
// تحميل إعدادات Firebase من البيئة — مصدر واحد مشترك بين:
//   - FCM (إشعارات الدفع) في src/notifications/fcm.js
//   - التحقق من ID token في src/utils/firebaseIdToken.js
//
// المطلوب في البيئة (زي بتاع fcm.js):
//   FIREBASE_SERVICE_ACCOUNT_PATH = مسار ملف الـ JSON الكامل (الأسهل)
//   أو:
//   FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY

const fs = require("node:fs");

function normalizePrivateKey(key) {
  if (!key) return null;
  // فك escape للسطور: "\\n" اللي في النص بيدوب لسطور حقيقية
  const parsed = key.replace(/\\n/g, "\n");
  // لو جا السطر كله سطر واحد من غير BEGIN (بيحصل لو اتنسخ من الكروم مع wrap)
  if (!parsed.includes("-----BEGIN") && !key.includes("\\n") && key.length > 200) {
    const body = parsed.replace(/\r/g, "").trim();
    return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
  }
  return parsed;
}

function loadFirebaseConfig() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    const raw = fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8");
    const sa = JSON.parse(raw);
    return {
      projectId: sa.project_id,
      clientEmail: sa.client_email,
      privateKey: normalizePrivateKey(sa.private_key),
    };
  }
  return {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY),
  };
}

module.exports = { loadFirebaseConfig, normalizePrivateKey };
