// confirm_commission.js
//
// أداة صاحب المنصة لتأكيد استلام العمولة وتحرير الحظر عن الصنايعي.
//
// تشغيل:
//   node confirm_commission.js            -> يعرض الدفعات المعلقة
//   node confirm_commission.js <id>       -> يؤكد دفعة ويحرر الحظر
//
// ملحوظة: مفروض تشغّلها بعد ما تتأكد إن الفلوس فعلاً وصلتك
// (InstaPay / Vodafone Cash / PayPal).

const db = require("./src/db");
const wallet = require("./src/wallet");

async function main() {
  await db.ready;

  const id = process.argv[2];

  if (!id) {
    const rows = await db.all(
      "SELECT id, provider_id, amount, method, note, created_at FROM commission_payments WHERE status = 'pending_confirmation' ORDER BY created_at DESC"
    );
    if (!rows.length) {
      console.log("مفيش دفعات معلقة حالياً.");
      process.exit(0);
    }
    for (const r of rows) {
      console.log(`${r.id}`);
      console.log(`  مبلغ: ${r.amount} | طريقة: ${r.method} | التاريخ: ${r.created_at}`);
      if (r.note) console.log(`  ملاحظة: ${r.note}`);
      console.log("");
    }
    console.log("للتأكيد اكتب: node confirm_commission.js <id>");
    process.exit(0);
  }

  const payment = await db.get("SELECT * FROM commission_payments WHERE id = ?", [id]);
  if (!payment) {
    console.log("الدفعة دي مش موجودة.");
    process.exit(1);
  }
  if (payment.status === "confirmed") {
    console.log("الدفعة دي متأكدة من قبل كده.");
    process.exit(0);
  }

  const res = await wallet.confirmCommissionPayment(id);
  if (res.error) {
    console.log("خطأ:", res.error);
    process.exit(1);
  }
  console.log(`تم تأكيد الدفعة ✅`);
  console.log(`المستحقات المتبقية للصنايعي: ${res.unpaid_commission}`);
  console.log(res.unpaid_commission === 0 ? "الحظر اتحرر من الصنايعي ✅" : "الصنايعي لسه محظور لحد ما يكمل المستحقات.");

  if (db.mode === "postgres") await db.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("خطأ:", err.message || err);
  process.exit(1);
});
