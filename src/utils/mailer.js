// src/utils/mailer.js
//
// Send OTP codes by email. Providers (all free-tier friendly, no card needed):
//   - console (default): print the code in the terminal (dev mode)
//   - brevo  : https://www.brevo.com  -> free 300 emails/day
//   - resend : https://resend.com      -> free test tier
//
// Env vars:
//   MAIL_PROVIDER=console|brevo|resend
//   BREVO_API_KEY=...
//   BREVO_FROM_EMAIL=...   (verified sender, e.g. your@gmail.com)
//   BREVO_FROM_NAME=...
//   RESEND_API_KEY=...
//   RESEND_FROM_EMAIL=...  (e.g. Acme <onboarding@resend.dev>)

function logError(ctx, err) {
  console.error(
    "[MAIL][" + ctx + "] failed:",
    err && err.message ? err.message : err
  );
}

async function sendBrevo(to, subject, html) {
  const apiKey = process.env.BREVO_API_KEY;
  const fromEmail = process.env.BREVO_FROM_EMAIL;
  if (!apiKey || !fromEmail) {
    throw new Error("BREVO_API_KEY / BREVO_FROM_EMAIL env vars are missing");
  }
  const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": apiKey,
    },
    body: JSON.stringify({
      sender: {
        email: fromEmail,
        name: process.env.BREVO_FROM_NAME || "Ammar",
      },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }),
  });
  if (!resp.ok) {
    throw new Error("Brevo HTTP " + resp.status + ": " + (await resp.text()));
  }
  return resp.json();
}

async function sendResend(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) {
    throw new Error("RESEND_API_KEY / RESEND_FROM_EMAIL env vars are missing");
  }
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      html,
    }),
  });
  if (!resp.ok) {
    throw new Error("Resend HTTP " + resp.status + ": " + (await resp.text()));
  }
  return resp.json();
}

// Send an OTP code by email. Prints to console in dev mode.
async function sendOtpEmail(email, code) {
  const provider = (process.env.MAIL_PROVIDER || "console").toLowerCase();
  const subject = "كود التحقق من Ammar";
  const html =
    "<div dir='rtl' style='font-family:sans-serif;line-height:1.7'>" +
    "<h3>مرحباً بك في Ammar</h3>" +
    "<p>كود التحقق الخاص بك هو:</p>" +
    "<div style='font-size:28px;font-weight:bold;letter-spacing:6px;background:#f5f5f5;padding:12px;text-align:center'>" +
    code +
    "</div>" +
    "<p>لا تشارك هذا الكود مع أي شخص.</p>" +
    "</div>";

  const isDev = !process.env.NODE_ENV || process.env.NODE_ENV === "development";
  if (isDev) {
    console.log("[DEV ONLY] EMAIL OTP for " + email + ": " + code);
  }

  if (provider === "brevo") {
    await sendBrevo(email, subject, html);
  } else if (provider === "resend") {
    await sendResend(email, subject, html);
  } else {
    return { provider: "console" };
  }

  console.log("[MAIL][" + provider + "] sent to " + email);
  return { provider };
}

module.exports = { sendOtpEmail, sendBrevo, sendResend };
