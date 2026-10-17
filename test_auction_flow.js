// اختبار الفلو الكامل لطلبات عروض الأسعار (مزاد) — بيفحص كل النهايات
// الجديدة اللي التطبيق بيستخدمها:
//   POST /service-requests (تخمين السعر من بنود المهنة)
//   GET  /service-requests/available (قائمة الصنايعي)
//   POST /service-requests/:id/quotes (قبول بسعر العميل / سعر بديل)
//   POST /service-requests/:id/price-bump (+5)
//   GET  /service-requests (قائمة العميل)
//   POST /service-requests/:id/confirm → order موثق (accepted)
const { spawn } = require("node:child_process");
const { once } = require("node:events");

const BASE = process.env.MZAD_TEST_BASE || "http://127.0.0.1:3102";
const PORT = 3102;

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
    otp: "1234",
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

(async () => {
  const server = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      JWT_SECRET: "01234567890123456789012345678901",
      DEV_OTP: "1234",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", (chunk) => { output += chunk; });
  server.stderr.on("data", (chunk) => { output += chunk; });

  try {
    await waitForServer();
    // أرقام فريدة لكل تشغيل عشان قاعدة البيانات المحلية المشتركة
    // متأثرش على النتيجة من تشغيل سابق.
    const run = Date.now() % 100000000;
    const clientPhone = "010" + String(run).padStart(8, "0");
    const providerPhone = "011" + String((run + 1) % 100000000).padStart(8, "0");
    const client = await login(clientPhone, "Mazad Client");
    const provider = await login(providerPhone, "Mazad Provider");

    // 1) إنشاء طلب بأي كمية — السعر يتخمن من بنود المهنة (defaultPrices)
    const create = await api("POST", "/service-requests", client.access_token, {
      category_id: 1,
      address_text: "القاهرة — مزاد",
      lat: 30.05,
      lng: 31.24,
      description: "تركيب حوض + تسريب",
      order_details: { work_hour: 2, sink_install: 1 },
    });
    if (create.status !== 201) throw new Error(`create: ${JSON.stringify(create)}`);
    const requestId = create.data.id;
    if (!(create.data.price > 0)) throw new Error(`price not estimated: ${create.data.price}`);

    // 2) قبل ما الصنايعي يفعل التوفر: الـ available يرجع 409 أو قايمة فاضية
    const notAvailableYet = await api("GET", "/service-requests/available", provider.access_token);
    if (notAvailableYet.status === 200 && notAvailableYet.data.requests.length) {
      throw new Error(`available before setup should be empty`);
    }

    // 3) تفعيل الصنايعي على المهنة وتظبيط أسعاره
    const mode = await api("POST", "/auth/switch-mode", provider.access_token, { enable_provider_mode: true });
    if (mode.status !== 200) throw new Error(`mode: ${JSON.stringify(mode)}`);
    const refresh = await api("POST", "/auth/refresh", null, { refresh_token: provider.refresh_token });
    const pToken = refresh.data.access_token;
    const availability = await api("PATCH", "/providers/me/availability", pToken, {
      is_available: true,
      lat: 30.05,
      lng: 31.24,
      category_ids: [1],
      pricing_data: PLUMBER_RATES,
    });
    if (availability.status !== 200 || !availability.data.is_available) {
      throw new Error(`availability: ${JSON.stringify(availability)}`);
    }

    // 4) الطلب بيظهر في قايمة العروض المتاحة عند الصنايعي
    const available = await api("GET", "/service-requests/available", pToken);
    if (available.status !== 200) throw new Error(`available: ${JSON.stringify(available)}`);
    const found = available.data.requests.find((r) => r.id === requestId);
    if (!found) throw new Error(`request not in available list`);

    // 5) عرض من غير سعر = قبول بسعر العميل (زي ما التطبيق بيعمل)
    const quoteNoPrice = await api("POST", `/service-requests/${requestId}/quotes`, pToken, {
      estimated_hours: 1,
    });
    if (quoteNoPrice.status !== 201) throw new Error(`quote no price: ${JSON.stringify(quoteNoPrice)}`);
    if (quoteNoPrice.data.price !== create.data.price) {
      throw new Error(`quote should match client price: ${JSON.stringify(quoteNoPrice.data)}`);
    }

    // 6) زيادة +5 من العميل — السعر بيتحدث
    const bump = await api("POST", `/service-requests/${requestId}/price-bump`, client.access_token);
    if (bump.status !== 200 || bump.data.price !== create.data.price + 5) {
      throw new Error(`bump: ${JSON.stringify(bump)}`);
    }

    // 7) عرض بديل بسعر مختلف من الصنايعي
    const quoteAlt = await api("POST", `/service-requests/${requestId}/quotes`, pToken, {
      price: 1000,
      estimated_hours: 2,
      notes: "عرض مريح",
    });
    if (quoteAlt.status !== 201) throw new Error(`quote alt: ${JSON.stringify(quoteAlt)}`);

    // 8) قايمة العميل فيها الطلب — وكل صنايعي ليه عرض واحد بس (upsert):
    //    العرض التاني حل محل الأول من نفس الصنايعي.
    const clientList = await api("GET", "/service-requests", client.access_token);
    if (clientList.status !== 200) throw new Error(`client list: ${JSON.stringify(clientList)}`);
    const inList = clientList.data.requests.find((r) => r.id === requestId);
    if (!inList) throw new Error(`request missing from client list`);
    if (inList.quote_count !== 1) throw new Error(`quote_count wrong: ${JSON.stringify(inList)}`);
    if (inList.average_price !== 1000) throw new Error(`average wrong: ${JSON.stringify(inList)}`);

    // 9) التأكيد على عرض الصنايعي البديل بالضبط (من غير تعديل)
    const confirm = await api("POST", `/service-requests/${requestId}/confirm`, client.access_token, {
      quote_id: quoteAlt.data.id,
      price_adjustment: 0,
    });
    if (confirm.status !== 200 || confirm.data.status !== "accepted") {
      throw new Error(`confirm: ${JSON.stringify(confirm)}`);
    }
    if (confirm.data.price !== 1000) throw new Error(`confirm price mismatch: ${JSON.stringify(confirm.data)}`);
    if (!confirm.data.order_id) throw new Error(`no order_id after confirm`);

    // 10) الطلب اختفي من available والعميل شايف أن الواحد (await) قفل
    const availableAfter = await api("GET", "/service-requests/available", pToken);
    if (availableAfter.status === 200 && availableAfter.data.requests.some((r) => r.id === requestId)) {
      throw new Error(`request still available after confirm`);
    }

    console.log("PASS auction flow (estimate → bump → quotes → confirm → order)");
  } finally {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
    if (server.exitCode === null) server.kill("SIGKILL");
  }
})().catch((error) => {
  console.error("FAIL", error.message);
  process.exitCode = 1;
});