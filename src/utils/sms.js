// src/utils/sms.js
//
// Send real OTP SMS. Supported providers:
//   - smsmisr  (SMS Misr - Egypt)
//   - vonage   (Vonage / Nexmo)
//
// Configuration via env vars (or a .env / shell):
//   SMS_PROVIDER=none|smsmisr|vonage     (default: none)
//   SMS_FROM=DisplayName                  (fallback sender name)
//
//   SMS_MISR_USERNAME=...
//   SMS_MISR_PASSWORD=...
//   SMS_MISR_SENDER=...                   (registered sender name)
//
//   VONAGE_API_KEY=...
//   VONAGE_API_SECRET=...
//   VONAGE_FROM=...                       (sender id/number)
//
// When SMS_PROVIDER=none (dev mode) the code is only printed to the
// console so you can keep developing without a real SMS account.

function logError(ctx, err) {
  console.error(
    "[SMS][" + ctx + "] failed:",
    err && err.message ? err.message : err
  );
}

// SMS Misr API (https://smsmisr.com/api/SMS/)
async function sendSmsMisr(to, message) {
  const username = process.env.SMS_MISR_USERNAME;
  const password = process.env.SMS_MISR_PASSWORD;
  const sender = process.env.SMS_MISR_SENDER || process.env.SMS_FROM;
  if (!username || !password || !sender) {
    throw new Error("SMS_MISR_USERNAME / SMS_MISR_PASSWORD / SMS_MISR_SENDER env vars are missing");
  }

  // environment: 1 = live, 2 = test sandbox
  const environment = process.env.SMS_MISR_ENVIRONMENT || "2";

  // language: 1 = English, 2 = Arabic, 3 = Unicode. OTP text is Arabic.
  const language = process.env.SMS_MISR_LANGUAGE || "2";

  const body = new URLSearchParams({
    environment,
    username,
    password,
    sender,
    mobile: to,
    language,
    message,
  });

  const resp = await fetch("https://smsmisr.com/api/SMS/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const data = await resp.json();
  const ok = String(data.code) === "1901";
  if (!ok) {
    throw new Error(
      "SMS Misr code=" + data.code + " error=" + (data.errorMessage || data.message || "")
    );
  }
  return data;
}

// Vonage / Nexmo SMS API (https://developer.vonage.com/api/sms)
async function sendSmsVonage(to, message) {
  const apiKey = process.env.VONAGE_API_KEY;
  const apiSecret = process.env.VONAGE_API_SECRET;
  const from = process.env.VONAGE_FROM || process.env.SMS_FROM || "UTLOB-SANAI";
  if (!apiKey || !apiSecret) {
    throw new Error("VONAGE_API_KEY / VONAGE_API_SECRET env vars are missing");
  }

  const params = new URLSearchParams({
    api_key: apiKey,
    api_secret: apiSecret,
    from,
    to,
    text: message,
    type: "unicode",
  });

  const resp = await fetch("https://rest.nexmo.com/sms/json?" + params.toString());
  const data = await resp.json();
  const msg = data.messages && data.messages[0];
  if (!msg || msg.status !== "0") {
    throw new Error(
      "Vonage error=" + (msg ? msg["error-text"] : "no response from gateway")
    );
  }
  return data;
}

// Send an OTP code. Falls back to console printing in dev mode.
async function sendOtp(phone, code) {
  const provider = (process.env.SMS_PROVIDER || "none").toLowerCase();
  const message = "كود التحقق في تطبيق طلب صنايعية: " + code;

  // In dev/test mode always show the code so you can complete the flow.
  const isDev = !process.env.NODE_ENV || process.env.NODE_ENV === "development";
  const isTest = process.env.SMS_MISR_ENVIRONMENT === "2";
  if (isDev || isTest) {
    console.log("[DEV ONLY] OTP for " + phone + ": " + code);
  }

  if (provider === "smsmisr") {
    await sendSmsMisr(phone, message);
  } else if (provider === "vonage") {
    await sendSmsVonage(phone, message);
  } else {
    return { provider: "console" };
  }

  console.log("[SMS][" + provider + "] sent to " + phone);
  return { provider };
}

module.exports = { sendOtp, sendSmsMisr, sendSmsVonage };
