// src/routes/wallet.js
//
// محفظة الصنايعي + سداد عمولة المنصة.
// ملحوظة: تأكيد استلام العمولة بيتم عبر مفتاح أدمن (X-Admin-Key).

const { requireAuth } = require("../middleware");
const walletService = require("../wallet");

async function adminAuthorized(req) {
  // مفتاح الأدمن بييجي من البيئة بس (ADMIN_KEY) — مفيش مفتاح افتراضي خالص.
  // لو مفتاح الأدمن مش متظبط، شاشات الإدارة مقفولة تمامًا (403).
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) return false;
  const supplied = req.headers["x-admin-key"];
  return supplied && supplied === adminKey;
}

// GET /wallet — ملخص محفظة الصنايعي + حركاته
async function getWallet(req) {
  const payload = await requireAuth(req);
  const provider = await requireProvider(payload.sub);
  if (!provider) return { status: 403, data: { error: "not_a_provider" } };

  const wallet = await walletService.getOrCreateWallet(provider.id);
  const block = await walletService.getBlockStatus(provider.id);
  const percent = await walletService.getCommissionPercent();

  const transactions = await require("../db").all(
    "SELECT id, kind, amount, note, order_id, created_at FROM wallet_transactions WHERE wallet_id = ? ORDER BY created_at DESC LIMIT 50",
    [wallet.id]
  );

  const pendingPayments = await require("../db").all(
    "SELECT id, amount, method, status, note, created_at FROM commission_payments WHERE provider_id = ? AND status = 'pending_confirmation' ORDER BY created_at DESC",
    [provider.id]
  );

  return {
    status: 200,
    data: {
      wallet: {
        total_earned: wallet.total_earned,
        total_commission: wallet.total_commission,
        unpaid_commission: block.unpaid_commission,
        threshold: block.threshold,
        blocked: block.blocked,
      },
      commission_percent: percent,
      payout_accounts: await walletService.getPayoutAccounts(),
      transactions,
      pending_payments: pendingPayments,
    },
  };
}

// POST /wallet/commission/pay — الصنايعي بيقول "أنا حولت العمولة"
async function payCommission(req, res, body) {
  const payload = await requireAuth(req);
  const provider = await requireProvider(payload.sub);
  if (!provider) return { status: 403, data: { error: "not_a_provider" } };

  const { amount, method, note } = body;
  const methods = ["instapay", "vodafone", "paypal", "cash"];
  if (!amount || Number(amount) <= 0) return { status: 400, data: { error: "amount_required" } };
  if (!methods.includes(method)) return { status: 400, data: { error: "invalid_method" } };

  const block = await walletService.getBlockStatus(provider.id);
  if (Number(amount) > block.unpaid_commission) {
    return { status: 400, data: { error: "amount_exceeds_unpaid_commission" } };
  }

  const payment = await walletService.createCommissionPayment(provider.id, Number(amount), method, note);
  return {
    status: 201,
    data: {
      message: "payment_submitted_pending_confirmation",
      payment: {
        id: payment.id,
        amount: payment.amount,
        method: payment.method,
        status: payment.status,
      },
    },
  };
}

// POST /wallet/commission/confirm — صاحب المنصة بيأكد إنه استلم الفلوس
// (التصريح بمفتاح الأدمن لوحده — X-Admin-Key)
async function confirmCommission(req, res, body) {
  if (!(await adminAuthorized(req))) return { status: 403, data: { error: "admin_unauthorized" } };

  const { payment_id } = body;
  if (!payment_id) return { status: 400, data: { error: "payment_id_required" } };

  const result = await walletService.confirmCommissionPayment(payment_id);
  if (result.error) return { status: 404, data: { error: result.error } };
  return { status: 200, data: { message: "commission_confirmed", unpaid_commission: result.unpaid_commission } };
}

// GET /admin/commissions — نظرة شاملة لصاحب المنصة: مين عليه فلوس + دفعات معلقة
async function adminCommissions(req) {
  if (!(await adminAuthorized(req))) return { status: 403, data: { error: "admin_unauthorized" } };

  const db = require("../db");
  const providers = await db.all(
    `SELECT pp.id AS provider_id, u.name, u.phone_number,
       w.unpaid_commission, w.total_commission, w.total_earned,
       CASE WHEN w.unpaid_commission > 0 THEN 1 ELSE 0 END AS blocked
     FROM provider_profiles pp
     JOIN users u ON u.id = pp.user_id
     LEFT JOIN provider_wallets w ON w.provider_id = pp.id
     WHERE u.is_active = 1
     ORDER BY w.unpaid_commission DESC`
  );
  const pendingPayments = await db.all(
    "SELECT * FROM commission_payments WHERE status = 'pending_confirmation' ORDER BY created_at DESC"
  );
  return { status: 200, data: { providers, pending_payments: pendingPayments } };
}

async function requireProvider(userId) {
  const db = require("../db");
  return await db.get("SELECT * FROM provider_profiles WHERE user_id = ?", [userId]);
}

// POST /wallet/transactions/clear — "مسح السجل": بيمسح سجل حركات
// الصنايعي اللي بيمسح بس نهائيًا (حط السجل ده ملكه وحده)، من غير
// ما يلمس أي أرصدة (إجمالي الإيراد/العمولة/المسحوب).
async function clearWalletTransactions(req) {
  const payload = await requireAuth(req);
  const provider = await requireProvider(payload.sub);
  if (!provider) return { status: 403, data: { error: "not_a_provider" } };

  const db = require("../db");
  const wallet = await walletService.getOrCreateWallet(provider.id);
  const res = await db.run("DELETE FROM wallet_transactions WHERE wallet_id = ?", [wallet.id]);
  return { status: 200, data: { cleared: res.changes || 0 } };
}

module.exports = { getWallet, payCommission, confirmCommission, adminCommissions, clearWalletTransactions };
