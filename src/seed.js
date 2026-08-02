// src/seed.js
//
// بيانات تجريبية: بيزرع ٤ صنايعية بمواقع قريبة من مدينة نصر، القاهرة،
// عشان endpoint /providers/nearby يرجع نتائج فعلية وانت بتجرب التطبيق.
//
// التشغيل:  node src/seed.js

const db = require("./db");
const { uuid } = require("./utils/helpers");

const sample = [
  { name: "محمود عبد الله", phone: "+201011111111", cat: 1, lat: 30.0561, lng: 31.3396, rating: 4.8, jobs: 210 },
  { name: "أحمد سيد",      phone: "+201022222222", cat: 1, lat: 30.0601, lng: 31.3450, rating: 4.6, jobs: 150 },
  { name: "كريم فتحي",     phone: "+201033333333", cat: 2, lat: 30.0530, lng: 31.3410, rating: 4.9, jobs: 300 },
  { name: "إسلام محمد",    phone: "+201044444444", cat: 3, lat: 30.0580, lng: 31.3370, rating: 4.5, jobs: 90  },
];

for (const p of sample) {
  let user = db.get("SELECT * FROM users WHERE phone_number = ?", [p.phone]);
  if (!user) {
    const userId = uuid();
    db.run(
      "INSERT INTO users (id, phone_number, name, user_type, is_active) VALUES (?, ?, ?, 'both', 1)",
      [userId, p.phone, p.name]
    );
    user = db.get("SELECT * FROM users WHERE id = ?", [userId]);
  }

  let profile = db.get("SELECT * FROM provider_profiles WHERE user_id = ?", [user.id]);
  if (!profile) {
    const profileId = uuid();
    db.run(
      `INSERT INTO provider_profiles
        (id, user_id, national_id_verified, is_available, current_lat, current_lng, rating_avg, rating_count, jobs_completed)
       VALUES (?, ?, 1, 1, ?, ?, ?, 40, ?)`,
      [profileId, user.id, p.lat, p.lng, p.rating, p.jobs]
    );
    profile = db.get("SELECT * FROM provider_profiles WHERE id = ?", [profileId]);
  }

  db.run("INSERT OR IGNORE INTO provider_categories (provider_id, category_id) VALUES (?, ?)", [
    profile.id,
    p.cat,
  ]);

  console.log(`✓ ${p.name} — تخصص ${p.cat} — متاح عند (${p.lat}, ${p.lng})`);
}

console.log("\nتم زرع البيانات التجريبية بنجاح.");
