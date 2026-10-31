// اختبار توقيت العمولة:
//   - بعد ما العميل يقبل عرض السعر، الطلب يفضل pending (في انتظار قبول
//     الصنايعي) — مش accepted.
//   - أول ما الصنايعي يقبل الطلب (فتح شغلانة حالية) الحالة تتحول accepted
//     والعمولة تتسجل مرة واحدة في المحفظة.
//   - إكمال الشغلانة مبيسجلش عمولة تانية.
const { spawn } = require("node:child_process");
const { once } = require("node:events");

const PORT = 3111;
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
  r = await api("POST", "/auth/verify", null, { phone_number: phone, otp: process.env.DEV_OTP || "1234", name });
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
  server.stdout.on("data", (c) => (output += c));
  server.stderr.on("data", (c) => (output += c));

  try {
    await waitForServer();
    const suffix = String(Date.now()).slice(-8);
    const client = await login(`010${suffix}`, "Timing Client");
    const provider = await login(`011${suffix}`, "Timing Provider");

    const providerMode = await api("POST", "/auth/switch-mode", provider.access_token, { enable_provider_mode: true });
    if (providerMode.status !== 200) throw new Error(`provider mode: ${JSON.stringify(providerMode)}`);
    const refresh = await api("POST", "/auth/refresh", null, { refresh_token: provider.refresh_token });
    const pToken = refresh.data.access_token;

    const pricing = {
      work_hour: 100, fixture_install: 50, leak_visit: 75, sink_install: 60,
      wc_base_install: 60, heater_install: 60, pump_install_sp: 60, float_install: 60,
      drain_snaking_sink: 60, drain_snaking_main: 60, pipe_leak_repair: 60,
      water_pipe_fix: 60, drain_pipe_fix: 60, filter_install: 60, valve_install: 60,
      sevo_install: 60, shower_install: 60, tub_install: 60, toilet_repair: 60,
      bath_pipes_setup: 60, kitchen_pipes_setup: 60,
    };
    const availability = await api("PATCH", "/providers/me/availability", pToken, {
      is_available: true, lat: 30.04, lng: 31.23, category_ids: [1], pricing_data: pricing,
    });
    if (availability.status !== 200) throw new Error(`availability: ${JSON.stringify(availability)}`);

    const req = await api("POST", "/service-requests", client.access_token, {
      category_id: 1, address_text: "Cairo timing test", lat: 30.04, lng: 31.23,
      description: "تسريب", order_details: { work_hour: 1 },
    });
    if (req.status !== 201) throw new Error(`create request: ${JSON.stringify(req)}`);

    const quote = await api("POST", `/service-requests/${req.data.id}/quotes`, pToken, { price: 200, estimated_hours: 1 });
    if (quote.status !== 201) throw new Error(`quote: ${JSON.stringify(quote)}`);

    const confirm = await api("POST", `/service-requests/${req.data.id}/confirm`, client.access_token, {
      quote_id: quote.data.id, price_adjustment: 0,
    });
    if (confirm.status !== 200) throw new Error(`confirm: ${JSON.stringify(confirm)}`);
    const orderId = confirm.data.order_id;

    // 1) بعد قبول العميل: الطلب (والترacking) لازم يفضل pending
    let order = await api("GET", `/orders/${orderId}`, client.access_token);
    if (order.status !== 200) throw new Error(`client getOrder: ${JSON.stringify(order)}`);
    if (order.data.status !== "pending") throw new Error(`expected pending after confirm, got ${order.data.status}`);
    console.log("PASS order is pending right after quote confirmation (waiting for craftsman)");

    // 2) الصنايعي يفتح شغلانة حالية → acceptOrder: العمولة تتحسب والحالة accepted
    const accept = await api("PATCH", `/orders/${orderId}/accept`, pToken);
    if (accept.status !== 200) throw new Error(`accept: ${JSON.stringify(accept)}`);
    if (accept.data.status !== "accepted") throw new Error(`expected accepted after accept, got ${accept.data.status}`);
    if (accept.data.commission_charged !== true) throw new Error(`commission not flagged: ${JSON.stringify(accept.data)}`);
    const commission = Number(accept.data.commission_charged_amount);
    if (!(commission > 0)) throw new Error(`commission amount invalid: ${commission}`);
    console.log(`PASS craftsman accept flips status to accepted and charges commission once (${commission} EGP)`);

    // 3) إعادة القبول مرفوضة — مفيش عمولة تانية
    const again = await api("PATCH", `/orders/${orderId}/accept`, pToken);
    if (again.status === 200) throw new Error(`second accept should not succeed: ${JSON.stringify(again)}`);

    const wallet = await api("GET", "/wallet", pToken);
    if (wallet.status !== 200) throw new Error(`wallet: ${JSON.stringify(wallet)}`);
    const unpaid = Number(wallet.data.wallet.unpaid_commission);
    if (unpaid !== commission) throw new Error(`unpaid commission ${unpaid} != ${commission} (double charge?)`);
    const commissionTx = wallet.data.transactions.filter((t) => t.kind === "commission" && t.order_id === orderId);
    if (commissionTx.length !== 1) throw new Error(`expected exactly 1 commission tx, got ${commissionTx.length}`);
    const earningsTx = wallet.data.transactions.filter((t) => t.kind === "earnings" && t.order_id === orderId);
    if (earningsTx.length !== 1) throw new Error(`expected exactly 1 earnings tx, got ${earningsTx.length}`);
    console.log("PASS exactly one commission + one earnings transaction in wallet");

    // 4) إكمال الطلب مبيسجلش عمولة تانية
    for (const next of ["on_way", "arrived", "in_progress", "completed"]) {
      const step = await api("PATCH", `/orders/${orderId}/status`, pToken, { status: next });
      if (step.status !== 200) throw new Error(`${next}: ${JSON.stringify(step)}`);
    }
    const walletAfter = await api("GET", "/wallet", pToken);
    const unpaidAfter = Number(walletAfter.data.wallet.unpaid_commission);
    if (unpaidAfter !== commission) throw new Error(`commission changed after completion: ${unpaidAfter} vs ${commission}`);
    const txAfter = walletAfter.data.transactions.filter((t) => t.kind === "commission" && t.order_id === orderId);
    if (txAfter.length !== 1) throw new Error(`duplicate commission after completion: ${txAfter.length}`);
    console.log("PASS completing the job does not charge commission again");

    order = await api("GET", `/orders/${orderId}`, client.access_token);
    if (order.data.status !== "completed") throw new Error(`client sees ${order.data.status}, expected completed`);
    console.log("ALL PASS commission timing + acceptance status");
  } finally {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
    if (server.exitCode === null) server.kill("SIGKILL");
    if (process.exitCode) console.error("SERVER OUTPUT:\n" + output.slice(-2000));
  }
})().catch((error) => {
  console.error("FAIL", error.message);
  process.exitCode = 1;
});
