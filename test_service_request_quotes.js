const { spawn } = require("node:child_process");
const { once } = require("node:events");

const BASE = process.env.SERVICE_REQUEST_TEST_BASE || "http://127.0.0.1:3101";
const PORT = 3101;

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
  const verified = await api("POST", "/auth/verify", null, { phone_number: phone, otp: process.env.DEV_OTP || "1234", name });
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
    const client = await login("01010000001", "Test Client");
    const provider = await login("01110000001", "Test Provider");

    const requestResult = await api("POST", "/service-requests", client.access_token, {
      category_id: 1,
      address_text: "Cairo test",
      lat: 30.04,
      lng: 31.23,
      description: "تسريب في الحوض",
      order_details: { work_hour: 1 },
    });
    if (requestResult.status !== 201) throw new Error(`create request failed: ${JSON.stringify(requestResult)}`);
    const requestId = requestResult.data.id;

    const providerMode = await api("POST", "/auth/switch-mode", provider.access_token, { enable_provider_mode: true });
    if (providerMode.status !== 200) throw new Error(`provider mode failed: ${JSON.stringify(providerMode)}`);
    const providerRefresh = await api("POST", "/auth/refresh", null, { refresh_token: provider.refresh_token });
    const providerTokenForMode = providerRefresh.data.access_token;
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
    const availability = await api("PATCH", "/providers/me/availability", providerTokenForMode, {
      is_available: true,
      lat: 30.04,
      lng: 31.23,
      category_ids: [1],
      pricing_data: pricingData,
    });
    if (availability.status !== 200 || !availability.data.is_available) {
      throw new Error(`availability setup failed: ${JSON.stringify(availability)}`);
    }

    const quoteResult = await api("POST", `/service-requests/${requestId}/quotes`, providerTokenForMode, {
      price: 150,
      estimated_hours: 2,
      notes: "تجربة اقتراح",
    });
    if (quoteResult.status !== 201) throw new Error(`create quote failed: ${JSON.stringify(quoteResult)}`);

    const quotesResult = await api("GET", `/service-requests/${requestId}/quotes`, client.access_token);
    if (quotesResult.status !== 200) throw new Error(`list quotes failed: ${JSON.stringify(quotesResult)}`);
    if (quotesResult.data.average_price !== 150 || quotesResult.data.quote_count !== 1) {
      throw new Error(`unexpected quote summary: ${JSON.stringify(quotesResult.data)}`);
    }

    const adjusted = await api("POST", `/service-requests/${requestId}/confirm`, client.access_token, {
      quote_id: quoteResult.data.id,
      price_adjustment: 1,
    });
    if (adjusted.status !== 200 || adjusted.data.status !== "accepted" || adjusted.data.price !== 155) {
      throw new Error(`confirm failed: ${JSON.stringify(adjusted)}`);
    }

    console.log("PASS service request quote flow");
  } finally {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
    if (server.exitCode === null) server.kill("SIGKILL");
  }
})().catch((error) => {
  console.error("FAIL", error.message);
  process.exitCode = 1;
});
