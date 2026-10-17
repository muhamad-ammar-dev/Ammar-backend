// اختبار منع التسجيل برقم موبايل مستخدم بالفعل على حساب تاني:
//   POST /auth/email/otp  → 400 phone_number_already_used لما الرقم على حساب مختلف
//   ونفس الإيميل+الرقم (صاحب الحساب) → بيعدّي عادي (200).
const { spawn } = require("node:child_process");

const BASE = process.env.PHONE_USED_TEST_BASE || "http://127.0.0.1:3104";
const PORT = 3104;
const OTP = "1234";

async function api(method, path, body) {
  const response = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  return { status: response.status, data };
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
    env: { ...process.env, PORT: String(PORT), DEV_OTP: OTP },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", (chunk) => { output += chunk; });
  server.stderr.on("data", (chunk) => { output += chunk; });

  try {
    await waitForServer();
    const run = Date.now() % 100000000;
    const phone1 = "010" + String(run).padStart(8, "0");
    const phone2 = "011" + String((run + 7) % 100000000).padStart(8, "0");
    const email1 = `used_${run}@example.com`;
    const email2 = `other_${run}@example.com`;
    const email3 = `fresh_${run}@example.com`;

    // 1) إنشاء حساب بالإيميل الأول + الرقم الأول
    let r = await api("POST", "/auth/email/otp", { email: email1, phone_number: phone1 });
    if (r.status !== 200) throw new Error(`first otp: ${JSON.stringify(r)}`);
    r = await api("POST", "/auth/email/verify", { email: email1, phone_number: phone1, otp: OTP, name: "Owner" });
    if (r.status !== 200) throw new Error(`first verify: ${JSON.stringify(r)}`);

    // 2) إيميل تاني + نفس الرقم → لازم يترفض قبل ما يتبعت الكود
    r = await api("POST", "/auth/email/otp", { email: email2, phone_number: phone1 });
    if (r.status !== 400 || r.data.error !== "phone_number_already_used") {
      throw new Error(`expected phone_number_already_used, got ${JSON.stringify(r)}`);
    }

    // 3) نفس الإيميل + نفس الرقم (صاحب الحساب) → يعدّي عادي
    r = await api("POST", "/auth/email/otp", { email: email1, phone_number: phone1 });
    if (r.status !== 200) throw new Error(`same account otp: ${JSON.stringify(r)}`);

    // 4) إيميل جديد + رقم جديد → يعدّي عادي
    r = await api("POST", "/auth/email/otp", { email: email3, phone_number: phone2 });
    if (r.status !== 200) throw new Error(`fresh otp: ${JSON.stringify(r)}`);

    console.log("PASS phone_number_already_used blocks early (different account), allows same account");
  } catch (err) {
    console.error("FAIL:", err.message);
    console.error("--- server output ---\n" + output);
    process.exitCode = 1;
  } finally {
    server.kill();
  }
})();
