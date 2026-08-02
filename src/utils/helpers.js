// src/utils/helpers.js
const crypto = require("node:crypto");

function uuid() {
  return crypto.randomUUID();
}

/** كود مصري: +20 أو 01 متبوعة بـ 9 أرقام (مبسّط لأغراض التطوير) */
function isValidEgyptianPhone(phone) {
  return /^(\+20|0)1[0125]\d{8}$/.test(phone);
}

function normalizePhone(phone) {
  if (phone.startsWith("+20")) return phone;
  if (phone.startsWith("0")) return "+20" + phone.slice(1);
  return phone;
}

function generateOtp() {
  return String(crypto.randomInt(1000, 9999));
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) req.destroy(); // حماية بسيطة من payload ضخم
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

module.exports = {
  uuid,
  isValidEgyptianPhone,
  normalizePhone,
  generateOtp,
  sendJson,
  readJsonBody,
};
