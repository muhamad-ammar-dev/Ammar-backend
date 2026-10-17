// اختبار "مسح السجل" كعميل: بيخفي طلبات عروض الأسعار المقفولة (اتقفل عليها)
// بس، ومش بيلمس الطلبات اللي لسه مفتوحة (waiting_for_quotes).
const { spawn } = require("node:child_process");

const BASE = process.env.CLEAR_HISTORY_TEST_BASE || "http://127.0.0.1:3105";
const PORT = 3105;

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
  work_hour: 100, fixture_install: 50, leak_visit: 75, sink_install: 60,
  wc_base_install: 60, heater_install: 60, pump_install_sp: 60, float_install: 60,
  drain_snaking_sink: 60, drain_snaking_main: 60, pipe_leak_repair: 60,
  water_pipe_fix: 60, drain_pipe_fix: 60, filter_install: 60, valve_install: 60,
  sevo_install: 60, shower_install: 60, tub_install: 60, toilet_repair: 60,
  bath_pipes_setup: 60, kitchen_pipes_setup: 60,
};

(async () => {
  const server = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), DEV_OTP: "1234" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", (chunk) => { output += chunk; });
  server.stderr.on("data", (chunk) => { output += chunk; });

  try {
    await waitForServer();
    const run = Date.now() % 100000000;
    const client = await login("010" + String(run).padStart(8, "0"), "Clear Client");
    const provider = await login("011" + String((run + 5) % 100000000).padStart(8, "0"), "Clear Provider");

    const createReq = () => api("POST", "/service-requests", client.access_token, {
      category_id: 1,
      address_text: "Cairo — اختبار مسح السجل",
      lat: 30.04,
      lng: 31.23,
      description: "تسريب في الحوض",
      order_details: { work_hour: 1 },
    });

    const openReq = await createReq();
    const closeReq = await createReq();
    if (openReq.status !== 201 || closeReq.status !== 201) {
      throw new Error(`create requests failed: ${JSON.stringify(openReq)} / ${JSON.stringify(closeReq)}`);
    }

    // تجهيز الصنايعي وتقديم عرض على الطلب اللي هنقفله
    const providerMode = await api("POST", "/auth/switch-mode", provider.access_token, { enable_provider_mode: true });
    if (providerMode.status !== 200) throw new Error(`provider mode failed: ${JSON.stringify(providerMode)}`);
    const providerRefresh = await api("POST", "/auth/refresh", null, { refresh_token: provider.refresh_token });
    const pToken = providerRefresh.data.access_token;
    const availability = await api("PATCH", "/providers/me/availability", pToken, {
      is_available: true, lat: 30.04, lng: 31.23, category_ids: [1], pricing_data: PLUMBER_RATES,
    });
    if (availability.status !== 200 || !availability.data.is_available) {
      throw new Error(`availability failed: ${JSON.stringify(availability)}`);
    }

    const quote = await api("POST", `/service-requests/${closeReq.data.id}/quotes`, pToken, {
      price: 150, estimated_hours: 2, notes: "عرض",
    });
    if (quote.status !== 201) throw new Error(`quote failed: ${JSON.stringify(quote)}`);
    const confirm = await api("POST", `/service-requests/${closeReq.data.id}/confirm`, client.access_token, {
      quote_id: quote.data.id,
    });
    if (confirm.status !== 200 || confirm.data.status !== "accepted") {
      throw new Error(`confirm failed: ${JSON.stringify(confirm)}`);
    }

    // قبل المسح: الطلبان ظاهرين
    let list = await api("GET", "/service-requests", client.access_token);
    if (list.status !== 200 || list.data.requests.length !== 2) {
      throw new Error(`before clear expected 2, got ${JSON.stringify(list.data)}`);
    }

    // مسح السجل
    const clear = await api("POST", "/orders/clear-completed", client.access_token);
    if (clear.status !== 200) throw new Error(`clear failed: ${JSON.stringify(clear)}`);

    // بعد المسح: الطلب المقفول اختفى، والمفتوح فضل موجود
    list = await api("GET", "/service-requests", client.access_token);
    const ids = list.data.requests.map((r) => r.id);
    if (ids.length !== 1 || ids[0] !== openReq.data.id) {
      throw new Error(`after clear expected only open request, got ${JSON.stringify(ids)}`);
    }

    console.log("PASS clear history hides closed service requests, keeps open ones");
  } catch (err) {
    console.error("FAIL:", err.message);
    console.error("--- server output ---\n" + output);
    process.exitCode = 1;
  } finally {
    server.kill();
  }
})();
