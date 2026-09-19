// src/wallet.js
//
// منطق محفظة الصنايعي والعمولة بتاعة المنصة.
//
// النموذج: العميل بيدفع للصنايعي كاش مباشرة على الأرض، والتطبيق بيسجّل
// عمولة المنصة (نسبة مئوية من سعر الشغلانة) كمستحقات على الصنايعي في
// محفظته. أول طلب بيتحسب عليه عمولته ويدخل الصنايعي عادي عشان يشتغل —
// من غير ما يدفع الأول. لكن لو عليه أي عمولة متسجلة مش متدفعة (من طلب
// قبله)، التطبيق بيمنعه يدخل/يقبل طلب جديد لحد ما يسدد عمولته (عبر
// InstaPay / Vodafone Cash / PayPal) ويأكد صاحب المنصة إن المبلغ وصل —
// زي ما بيحصل في لوحة الصنايعي بالظبط.
//
// كل الدوال async من الأول لآخر (بتحبس كلها بـ await في الكلينتات).

const { uuid } = require("./utils/helpers");
const { run, get, getSetting } = require("./db");

async function getCommissionPercent() {
  return Number(await getSetting("commission_percent", "10")) || 0;
}

async function getUnpaidThreshold() {
  return Number(await getSetting("unpaid_threshold", "100")) || 0;
}

async function getPayoutAccounts() {
  return {
    instapay: await getSetting("payout_instapay", ""),
    vodafone: await getSetting("payout_vodafone", ""),
    paypal: await getSetting("payout_paypal", ""),
  };
}

/** بيلاقي أو بيعمل محفظة للصنايعي ويرجعها */
async function getOrCreateWallet(providerId) {
  let wallet = await get("SELECT * FROM provider_wallets WHERE provider_id = ?", [providerId]);
  if (!wallet) {
    const id = uuid();
    await run("INSERT INTO provider_wallets (id, provider_id) VALUES (?, ?)", [id, providerId]);
    wallet = await get("SELECT * FROM provider_wallets WHERE provider_id = ?", [providerId]);
  }
  return wallet;
}

async function addTransaction(walletId, kind, amount, note, orderId = null) {
  await run(
    "INSERT INTO wallet_transactions (id, wallet_id, kind, amount, note, order_id) VALUES (?, ?, ?, ?, ?, ?)",
    [uuid(), walletId, kind, amount, note || null, orderId || null]
  );
}

/**
 * بيتنادى لما طلب يتسلم: بيسجّل الإيراد + عمولة المنصة كمستحقات.
 * بيرجع { price, commission } أو null لو مفيش سعر.
 */
async function recordCompletedOrder(order) {
  const price = Number(order.price);
  if (!price || price <= 0) return null;

  const percent = await getCommissionPercent();
  const commission = Math.round(price * percent) / 100;

  const wallet = await getOrCreateWallet(order.provider_id);
  await run(
    `UPDATE provider_wallets
     SET total_earned = total_earned + ?, total_commission = total_commission + ?,
         unpaid_commission = unpaid_commission + ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [price, commission, commission, wallet.id]
  );
  await addTransaction(wallet.id, "earnings", price, `إيراد طلب`, order.id);
  await addTransaction(wallet.id, "commission", commission, `عمولة المنصة (${percent}%)`, order.id);

  return { price, commission };
}

/**
 * عمولة "أول فتح للطلب" — بتتسجل أول مرة الصنايعي المعيّن يفتح الطلب
 * (حتى لو مكمّلش على "قبول الطلب"): بيحتسب عليه عمولة المنصة كمستحقات
 * برضه، من غير تسجيل إيراد (لسه مشتغلش الشغلانة). مرة واحدة لكل طلب —
 * بيتمنع التكرار بعلامة commission_charged_at على الطلب.
 * بيرجع { price, commission } أو null لو مفيش سعر.
 */
async function recordLeadCommission(order) {
  const price = Number(order.price);
  if (!price || price <= 0) return null;

  const percent = await getCommissionPercent();
  const commission = Math.round(price * percent) / 100;

  const wallet = await getOrCreateWallet(order.provider_id);
  await run(
    `UPDATE provider_wallets
     SET total_commission = total_commission + ?, unpaid_commission = unpaid_commission + ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [commission, commission, wallet.id]
  );
  await addTransaction(wallet.id, "commission", commission, `عمولة فتح الطلب (${percent}%)`, order.id);

  return { price, commission };
}

/**
 * تسجيل الإيراد بس من غير عمولة — بيتستخدم لما يكون فتح الطلب سبق
 * حصّل العمولة، والصنايعي قبله بعدين: بنسجّل إيراد الشغلانة عشان
 * إحصائيات المحفظة تفضل صحيحة من غير ما نضاعف العمولة (مرة واحدة).
 */
async function recordOrderEarnings(order) {
  const price = Number(order.price);
  if (!price || price <= 0) return null;

  const wallet = await getOrCreateWallet(order.provider_id);
  await run(
    `UPDATE provider_wallets
     SET total_earned = total_earned + ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [price, wallet.id]
  );
  await addTransaction(wallet.id, "earnings", price, `إيراد طلب`, order.id);

  return { price };
}

/** هل الصنايعي ممنوع من قبول طلبات جديدة بسبب مستحقات متدفعتش؟
 *  القاعدة: أول طلب بيتحسب عليه عمولته ويدخل عادي، ولو عليه أي عمولة
 *  متسجلة غير مدفوعة ممنوع يقبل/يفتح طلب جديد غير لما يسدد. */
async function isBlocked(wallet) {
  return Number(wallet.unpaid_commission) > 0;
}

/** حالة الحظر الكاملة (للمحفظة والـ UI) */
async function getBlockStatus(providerId) {
  const wallet = await getOrCreateWallet(providerId);
  const threshold = await getUnpaidThreshold();
  const unpaid = Number(wallet.unpaid_commission);
  return {
    unpaid_commission: unpaid,
    threshold,
    blocked: unpaid > 0,
  };
}

/** تسجيل دفعة عمولة من الصنايعي (قبل تأكيد المنصة) */
async function createCommissionPayment(providerId, amount, method, note) {
  const id = uuid();
  await run(
    "INSERT INTO commission_payments (id, provider_id, amount, method, note) VALUES (?, ?, ?, ?, ?)",
    [id, providerId, amount, method, note || null]
  );
  return get("SELECT * FROM commission_payments WHERE id = ?", [id]);
}

/** تأكيد المنصة إن الفلوس وصلت — بينقص المستحقات ويرجع الحظر لأصله */
async function confirmCommissionPayment(paymentId) {
  const payment = await get("SELECT * FROM commission_payments WHERE id = ?", [paymentId]);
  if (!payment) return { error: "payment_not_found" };
  if (payment.status === "confirmed") return { error: "already_confirmed" };

  const wallet = await getOrCreateWallet(payment.provider_id);
  const amount = Number(payment.amount);
  const newUnpaid = Math.max(0, Number(wallet.unpaid_commission) - amount);

  await run("UPDATE commission_payments SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP WHERE id = ?", [paymentId]);
  await run("UPDATE provider_wallets SET unpaid_commission = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [newUnpaid, wallet.id]);
  await addTransaction(wallet.id, "payment", -amount, `سداد عمولة (${payment.method})`);

  return { ok: true, unpaid_commission: newUnpaid };
}

module.exports = {
  getCommissionPercent,
  getUnpaidThreshold,
  getPayoutAccounts,
  getOrCreateWallet,
  addTransaction,
  recordCompletedOrder,
  recordLeadCommission,
  recordOrderEarnings,
  isBlocked,
  getBlockStatus,
  createCommissionPayment,
  confirmCommissionPayment,
};
