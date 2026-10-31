// اختبار صور المشكلة في طلبات عروض الأسعار:
//   - العميل يقدر يرفق لحد 3 صور، السيرفر بيرجّعها مع الطلب.
//   - الصنايعي بيشوف الصور في قايمة الطلبات المتاحة وفي صفحة العروض.
//   - لما العميل يختار عرض، الصور بتنتقل لصور الطلب نفسه.
//   - أكتر من 3 صور بيترفض.
const { spawn } = require("node:child_process");
const { once } = require("node:events");

const PORT = 3121;
const BASE = `http://127.0.0.1:${PORT}`;

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
  let r = await api("POST", "/auth/otp", null, { phone_number: phone });
  if (r.status !== 200) throw new Error(`OTP failed: ${JSON.stringify(r)}`);
  r = await api("POST", "/auth/verify", null, {
    phone_number: phone,
    otp: process.env.DEV_OTP || "1234",
    name,
  });
  if (r.status !== 200) throw new Error(`verify failed: ${JSON.stringify(r)}`);
  return r.data;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const r = await api("GET", "/health");
      if (r.status === 200) return;
    } catch (_) {}
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error("server did not start");
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

  try {
    await waitForServer();
    const client = await login("01010000077", "Images Client");
    const provider = await login("01110000077", "Images Provider");

    const img1 = "data:image/jpeg;base64,AAAA";
    const img2 = "data:image/jpeg;base64,BBBB";

    const created = await api("POST", "/service-requests", client.access_token, {
      category_id: 1,
      address_text: "Cairo images test",
      lat: 30.04,
      lng: 31.23,
      description: "مشكلة محتاجة صور",
      order_details: { work_hour: 1 },
      images: [img1, img2],
    });
    if (created.status !== 201) throw new Error(`create failed: ${JSON.stringify(created)}`);
    if (!Array.isArray(created.data.images) || created.data.images.length !== 2) {
      throw new Error(`images not returned on create: ${JSON.stringify(created.data)}`);
    }
    const requestId = created.data.id;

    // أكتر من 3 صور مرفوضة
    const tooMany = await api("POST", "/service-requests", client.access_token, {
      category_id: 1,
      address_text: "Cairo images test",
      lat: 30.04,
      lng: 31.23,
      description: "صور كتير",
      images: [img1, img1, img1, img1],
    });
    if (tooMany.status !== 400) throw new Error(`4 images should fail: ${JSON.stringify(tooMany)}`);

    // الصنايعي يجهّز نفسه
    const providerMode = await api("POST", "/auth/switch-mode", provider.access_token, { enable_provider_mode: true });
    if (providerMode.status !== 200) throw new Error(`provider mode failed: ${JSON.stringify(providerMode)}`);
    const providerRefresh = await api("POST", "/auth/refresh", null, { refresh_token: provider.refresh_token });
    const providerToken = providerRefresh.data.access_token;
    const pricingData = {
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
    const availability = await api("PATCH", "/providers/me/availability", providerToken, {
      is_available: true,
      lat: 30.04,
      lng: 31.23,
      category_ids: [1],
      pricing_data: pricingData,
    });
    if (availability.status !== 200 || !availability.data.is_available) {
      throw new Error(`availability failed: ${JSON.stringify(availability)}`);
    }

    const available = await api("GET", "/service-requests/available", providerToken);
    if (available.status !== 200) throw new Error(`available failed: ${JSON.stringify(available)}`);
    const listed = available.data.requests.find((r) => r.id === requestId);
    if (!listed || !Array.isArray(listed.images) || listed.images.length !== 2) {
      throw new Error(`images missing in available list: ${JSON.stringify(listed)}`);
    }

    const quote = await api("POST", `/service-requests/${requestId}/quotes`, providerToken, {
      price: 150,
      estimated_hours: 2,
    });
    if (quote.status !== 201) throw new Error(`quote failed: ${JSON.stringify(quote)}`);

    const quotesView = await api("GET", `/service-requests/${requestId}/quotes`, client.access_token);
    if (quotesView.status !== 200) throw new Error(`quotes view failed: ${JSON.stringify(quotesView)}`);
    if (!Array.isArray(quotesView.data.request.images) || quotesView.data.request.images.length !== 2) {
      throw new Error(`images missing in quotes view: ${JSON.stringify(quotesView.data.request)}`);
    }

    const confirmed = await api("POST", `/service-requests/${requestId}/confirm`, client.access_token, {
      quote_id: quote.data.id,
    });
    if (confirmed.status !== 200) throw new Error(`confirm failed: ${JSON.stringify(confirmed)}`);

    const order = await api("GET", `/orders/${confirmed.data.order_id}`, client.access_token);
    if (order.status !== 200) throw new Error(`order fetch failed: ${JSON.stringify(order)}`);
    if (!Array.isArray(order.data.images) || order.data.images.length !== 2) {
      throw new Error(`images not copied to order: ${JSON.stringify(order.data.images)}`);
    }

    console.log("PASS service request images flow");
  } catch (error) {
    console.error("FAIL", error.message);
    if (output) console.error(output.slice(-2000));
    process.exitCode = 1;
  } finally {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
    if (server.exitCode === null) server.kill("SIGKILL");
  }
})();
