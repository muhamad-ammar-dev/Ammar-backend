// End-to-end test for wallet/commission flow (ASCII output only)
const BASE = "http://localhost:3000";
const { setSetting } = require("./src/db");

let passed = 0, failed = 0;
function check(name, cond, extra = "") {
  if (cond) { passed++; console.log("PASS  " + name + (extra ? " | " + extra : "")); }
  else { failed++; console.log("FAIL  " + name + (extra ? " | " + extra : "")); }
}

async function api(method, path, token, body, adminKey) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(adminKey ? { "X-Admin-Key": adminKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

async function login(phone, name) {
  await api("POST", "/auth/otp", null, { phone_number: phone });
  const v = await api("POST", "/auth/verify", null, { phone_number: phone, otp: "1234", name });
  return v.data.access_token;
}

(async () => {
  await setSetting("unpaid_threshold", "10");
  await setSetting("admin_key", "test-key-123");

  const clientToken = await login("01012345678", "TestClient");
  let providerToken = await login("01111111111", "TestProvider");
  check("client+provider login", !!clientToken && !!providerToken);

  await api("POST", "/auth/switch-mode", providerToken, { enable_provider_mode: true });
  // الـ token القديم لسه بيقول user_type=client — نعيد تسجيل الدخول عشان ناخد
  // token جديد بـ user_type=both (أو نخلي الحاجة تفضى من الـ claim مش صحيح)
  providerToken = await login("01111111111", "TestProvider");
  await api("PATCH", "/providers/me/availability", providerToken, {
    is_available: true, lat: 30.04, lng: 31.23, category_ids: [1],
  });

  // --- order + accept with price ---
  const ord = await api("POST", "/orders", clientToken, {
    category_id: 1, address_text: "Cairo test", lat: 30.05, lng: 31.22, notes: "test job",
  });
  const orderId = ord.data.id;
  check("order created", orderId != null, "id=" + orderId);

  const avail = await api("GET", "/orders/available", providerToken);
  check("available shows order", (avail.data.orders || []).some((o) => o.id === orderId));
  check("available has block info", typeof avail.data.blocked === "boolean");

  const acc = await api("PATCH", "/orders/" + orderId + "/accept", providerToken, { price: 300 });
  check("accept with price 300", acc.status === 200, "status=" + acc.status);
  check("order price stored", Number(acc.data.price) === 300);

  // --- set price via endpoint ---
  const setP = await api("PATCH", "/orders/" + orderId + "/price", providerToken, { price: 350 });
  check("price endpoint updates to 350", setP.status === 200 && Number(setP.data.price) === 350, "status=" + setP.status);

  // --- complete flow (current design) ---
  // provider يشغّل على_الطريق -> وصل -> في_التنفيذ -> خلص (بتروح price_pending)
  for (const st of ["on_way", "arrived", "in_progress"]) {
    const r = await api("PATCH", "/orders/" + orderId + "/status", providerToken, { status: st });
    check("status -> " + st, r.status === 200, "status=" + r.status);
  }
  const done = await api("PATCH", "/orders/" + orderId + "/status", providerToken, { status: "completed" });
  check("provider completed -> price_pending", done.status === 200 && done.data.status === "price_pending", "status=" + done.data.status);

  // العميل يوافق على السعر => الطلب يخلص والمحفظة تتحسب
  const appr = await api("POST", "/orders/" + orderId + "/approve-price", clientToken, {});
  check("client approve price -> completed", appr.status === 200 && appr.data.status === "completed", "status=" + (appr.data && appr.data.status));

  // commission = 350 * 10% = 35
  const det = await api("GET", "/orders/" + orderId, clientToken);
  check("completed order has commission_amount=35", Number(det.data.commission_amount) === 35, "com=" + det.data.commission_amount);
  check("completed order has commission_percent=10", Number(det.data.commission_percent) === 10, "pct=" + det.data.commission_percent);

  // --- wallet ---
  const w1 = await api("GET", "/wallet", providerToken);
  check("wallet total_earned=350", Number(w1.data.wallet.total_earned) === 350, "earned=" + w1.data.wallet.total_earned);
  check("wallet unpaid_commission=35", Number(w1.data.wallet.unpaid_commission) === 35, "unpaid=" + w1.data.wallet.unpaid_commission);
  check("wallet blocked=true (35>=10)", w1.data.wallet.blocked === true);

  const ord2 = await api("POST", "/orders", clientToken, {
    category_id: 1, address_text: "Cairo second", lat: 30.05, lng: 31.22, notes: "second",
  });
  const acc2 = await api("PATCH", "/orders/" + ord2.data.id + "/accept", providerToken, { price: 100 });
  check("accept blocked with commission_unpaid", acc2.status === 403 && acc2.data.error === "commission_unpaid", "status=" + acc2.status + " err=" + acc2.data.error);

  // --- pay commission (35) then confirm as admin ---
  const adminKey = "test-key-123";
  const pay = await api("POST", "/wallet/commission/pay", providerToken, { amount: 35, method: "instapay", note: "test" });
  check("pay commission 201", pay.status === 201, "status=" + pay.status);
  const paymentId = pay.data.payment?.id;
  check("payment id present", paymentId != null);

  const conf = await api("POST", "/wallet/commission/confirm", null, { payment_id: paymentId }, adminKey);
  check("admin confirm commission", conf.status === 200, "status=" + conf.status);

  const w3 = await api("GET", "/wallet", providerToken);
  check("wallet unpaid=0 after confirm", Number(w3.data.wallet.unpaid_commission) === 0, "unpaid=" + w3.data.wallet.unpaid_commission);
  check("wallet blocked=false after confirm", w3.data.wallet.blocked === false);

  // --- admin commissions report ---
  const rep = await api("GET", "/admin/commissions", null, null, adminKey);
  check("admin commissions report 200", rep.status === 200, "status=" + rep.status);
  check("report has pending=0", (rep.data.pending_payments || []).length === 0);

  // --- admin key required ---
  const noKey = await api("GET", "/admin/commissions", null, null);
  check("admin without key rejected", noKey.status === 401 || noKey.status === 403, "status=" + noKey.status);

  // --- bad price / bad amount ---
  const badPrice = await api("PATCH", "/orders/" + orderId + "/price", providerToken, { price: -5 });
  check("negative price rejected", badPrice.status === 400, "status=" + badPrice.status);
  const badAmount = await api("POST", "/wallet/commission/pay", providerToken, { amount: 9999, method: "instapay" });
  check("overpay rejected", badAmount.status === 400, "status=" + badAmount.status);

  console.log("======================");
  console.log("TOTAL: " + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.log("CRASH: " + (e && e.message));
  process.exit(1);
});
