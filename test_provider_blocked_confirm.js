// اختبار منع تأكيد العميل لعرض صنايعي عليه مستحقات عمولة للمنصة:
//   GET  /service-requests/:id/quotes  → كل عرض معاه provider_blocked
//   POST /service-requests/:id/confirm  → 409 provider_commission_unpaid
//   وبعد ما المستحقات تتسدد → التأكيد ينجح تاني عادي
const { spawn } = require("node:child_process");
const { once } = require("node:events");

const BASE = process.env.BLOCKED_CONFIRM_TEST_BASE || "http://127.0.0.1:3103";
const PORT = 3103;

async function api(method, path, token, body) {
  const response = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  return { status: response.status, data };
}

async function login(phone, name) {
  const otp = await api("POST", "/auth/otp", null, { phone_number: phone });
  if (otp.status !== 200) throw new Error(`OTP failed: ${JSON.stringify(otp)}`);
  const verified = await api("POST", "/auth/verify", null, {
    phone_number: phone,
    otp: process.env.DEV_OTP || "1234",
    name,
  });
  if (verified.status !== 200) throw new Error(`verify failed: ${JSON.stringify(verified)}`);
  return verified.data;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const result = await api("GET", "/health");
      if (result.status === 200) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server did not start");
}

const PLUMBER_RATES = {
  work_hour: 100,
  fixture_install: 50,
  leak_visit: 75,
  sink_install: 60,
  wc_base_install: 60,
  heater_install: 60,
  pump_install_sp: 60,
  float_install: 60,
  drain_snaking_sink: 60,
  drain_snaking_main: 60,
  pipe_leak_repair: 60,
  water_pipe_fix: 60,
  drain_pipe_fix: 60,
  filter_install: 60,
  valve_install: 60,
  sevo_install: 60,
  shower_install: 60,
  tub_install: 60,
  toilet_repair: 60,
  bath_pipes_setup: 60,
  kitchen_pipes_setup: 60,
};

// بتحط مستحقات على محفظة الصنايعي عن طريق user id (مع إنشاء المحفظة لو مش موجودة)
async function setUnpaidCommission(userId, amount) {
  const db = require("./src/db");
  const { uuid } = require("./src/utils/helpers");
  await db.ready;
  await db.run(
    `INSERT INTO provider_wallets (id, provider_id, unpaid_commission)
     SELECT ?, pp.id, ? FROM provider_profiles pp
     WHERE pp.user_id = ?
     ON CONFLICT(provider_id) DO UPDATE SET unpaid_commission = excluded.unpaid_commission`,
    [uuid(), amount, userId]
  );
  return db;
}

(async () => {
  const server = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", (chunk) => { output += chunk; });
  server.stderr.on("data", (chunk) => { output += chunk; });

  let db = null;
  try {
    await waitForServer();
    // أرقام فريدة لكل تشغيل (قاعدة البيانات المحلية مشتركة)
    const run = Date.now() % 100000000;
    const clientPhone = "012" + String(run).padStart(8, "0");
    const providerPhone = "015" + String((run + 3) % 100000000).padStart(8, "0");
    const client = await login(clientPhone, "Blocked Confirm Client");
    const provider = await login(providerPhone, "Blocked Confirm Provider");

    const create = await api("POST", "/service-requests", client.access_token, {
      category_id: 1,
      address_text: "القاهرة — اختبار المستحقات",
      lat: 30.04,
      lng: 31.23,
      description: "تسريب في الحوض",
      order_details: { work_hour: 1 },
    });
    if (create.status !== 201) throw new Error(`create: ${JSON.stringify(create)}`);
    const requestId = create.data.id;

    const mode = await api("POST", "/auth/switch-mode", provider.access_token, { enable_provider_mode: true });
    if (mode.status !== 200) throw new Error(`mode: ${JSON.stringify(mode)}`);
    const refresh = await api("POST", "/auth/refresh", null, { refresh_token: provider.refresh_token });
    const pToken = refresh.data.access_token;
    const availability = await api("PATCH", "/providers/me/availability", pToken, {
      is_available: true,
      lat: 30.04,
      lng: 31.23,
      category_ids: [1],
      pricing_data: PLUMBER_RATES,
    });
    if (availability.status !== 200) throw new Error(`availability: ${JSON.stringify(availability)}`);

    const quote = await api("POST", `/service-requests/${requestId}/quotes`, pToken, {
      price: 150,
      estimated_hours: 2,
      notes: "عرض الصنايعي",
    });
    if (quote.status !== 201) throw new Error(`quote: ${JSON.stringify(quote)}`);

    // 1) صنايعي نضيف: العرض مش معلّم إنه محظور
    const clean = await api("GET", `/service-requests/${requestId}/quotes`, client.access_token);
    if (clean.status !== 200) throw new Error(`list quotes: ${JSON.stringify(clean)}`);
    if (clean.data.quotes.length !== 1) throw new Error(`expected 1 quote: ${JSON.stringify(clean.data)}`);
    if (clean.data.quotes[0].provider_blocked !== false) {
      throw new Error(`expected provider_blocked=false, got ${JSON.stringify(clean.data.quotes[0].provider_blocked)}`);
    }

    // 2) نزّل عليه مستحقات عمولة
    db = await setUnpaidCommission(provider.user.id, 50);

    // 3) العرض بقى معلّم إنه محظور
    const blocked = await api("GET", `/service-requests/${requestId}/quotes`, client.access_token);
    if (blocked.data.quotes[0].provider_blocked !== true) {
      throw new Error(`expected provider_blocked=true, got ${JSON.stringify(blocked.data.quotes[0].provider_blocked)}`);
    }

    // 4) التأكيد مرفوض
    const rejected = await api("POST", `/service-requests/${requestId}/confirm`, client.access_token, {
      quote_id: quote.data.id,
      price_adjustment: 0,
    });
    if (rejected.status !== 409 || rejected.data.error !== "provider_commission_unpaid") {
      throw new Error(`expected 409 provider_commission_unpaid, got ${JSON.stringify(rejected)}`);
    }
    if (!(rejected.data.unpaid_commission > 0)) {
      throw new Error(`expected unpaid_commission in error payload: ${JSON.stringify(rejected.data)}`);
    }

    // 5) الصنايعي سدّد → العرض رجع متاح
    await setUnpaidCommission(provider.user.id, 0);
    const unblocked = await api("GET", `/service-requests/${requestId}/quotes`, client.access_token);
    if (unblocked.data.quotes[0].provider_blocked !== false) {
      throw new Error(`expected provider_blocked=false after payment, got ${JSON.stringify(unblocked.data.quotes[0].provider_blocked)}`);
    }

    // 6) التأكيد نجح والمبلغ زي ما العرض حدّده
    const confirmed = await api("POST", `/service-requests/${requestId}/confirm`, client.access_token, {
      quote_id: quote.data.id,
      price_adjustment: 0,
    });
    if (confirmed.status !== 200 || confirmed.data.status !== "accepted" || confirmed.data.price !== 150) {
      throw new Error(`confirm after payment failed: ${JSON.stringify(confirmed)}`);
    }
    if (!confirmed.data.order_id) throw new Error("no order_id after confirm");

    console.log("PASS provider blocked confirm flow (block → reject → pay → confirm)");
  } catch (error) {
    console.error("SERVER OUTPUT:\n" + output);
    throw error;
  } finally {
    try {
      if (db && db.mode === "sqlite") await db.close();
    } catch (_) {}
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
    if (server.exitCode === null) server.kill("SIGKILL");
  }
})().catch((error) => {
  console.error("FAIL", error.message);
  process.exitCode = 1;
});
