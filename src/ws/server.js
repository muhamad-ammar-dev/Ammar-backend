// src/ws/server.js
//
// WebSocket server مبني يدويًا بـ node:http + node:crypto بس (بدون مكتبة
// `ws` أو أي حزمة خارجية) — نفس فلسفة باقي المشروع. بيدعم بس اللي محتاجينه:
// نصوص (text frames)، فريم واحد بدون تجزئة (كافي لرسائل JSON قصيرة زي بتاعتنا).
//
// لو حابب تستبدله بمكتبة `ws` الشهيرة لاحقًا (بعد ما تعمل npm install ws)،
// الـ hub.js (اللي بيدير القنوات) مستقل تمامًا عن تفاصيل البروتوكول هنا،
// فمش هتحتاج تغيّر منطق الـ pub/sub بتاعك.

const crypto = require("node:crypto");

const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function computeAcceptKey(key) {
  return crypto.createHash("sha1").update(key + WS_MAGIC).digest("base64");
}

/** يفك تشفير فريم واحد جاي من العميل (العميل دايمًا بيبعت البيانات مقنّعة/masked) */
function decodeFrame(buffer) {
  if (buffer.length < 2) return null;

  const byte0 = buffer[0];
  const opcode = byte0 & 0x0f;
  const byte1 = buffer[1];
  const masked = (byte1 & 0x80) !== 0;
  let payloadLen = byte1 & 0x7f;
  let offset = 2;

  if (payloadLen === 126) {
    if (buffer.length < 4) return null;
    payloadLen = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buffer.length < 10) return null;
    payloadLen = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }

  let maskKey = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    maskKey = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + payloadLen) return null; // frame مش كامل لسه

  let payload = buffer.subarray(offset, offset + payloadLen);
  if (masked) {
    const unmasked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
    payload = unmasked;
  }

  return { opcode, payload, frameLength: offset + payloadLen };
}

/** يبني فريم نصي (غير مقنّع، السيرفر مش لازم يقنّع البيانات) */
function encodeTextFrame(str) {
  const payload = Buffer.from(str, "utf8");
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, payload]);
}

function encodeCloseFrame() {
  return Buffer.from([0x88, 0x00]);
}

/**
 * يوصّل WebSocket handling بسيرفر HTTP موجود.
 * onConnection(conn, req) بيتنادى لكل اتصال جديد، وconn عنده:
 *   conn.send(str), conn.on('message', cb), conn.on('close', cb)
 */
function attachWebSocketServer(httpServer, onConnection) {
  httpServer.on("upgrade", (req, socket, head) => {
    if (req.headers["upgrade"] !== "websocket") {
      socket.destroy();
      return;
    }

    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }

    const acceptKey = computeAcceptKey(key);
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
        "\r\n"
    );

    let buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    const listeners = { message: [], close: [] };

    const conn = {
      send: (str) => {
        if (!socket.destroyed) socket.write(encodeTextFrame(str));
      },
      close: () => {
        if (!socket.destroyed) {
          socket.write(encodeCloseFrame());
          socket.end();
        }
      },
      on: (event, cb) => listeners[event]?.push(cb),
    };

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      // فك أكتر من فريم لو جواتهم في نفس الـ chunk
      while (true) {
        const frame = decodeFrame(buffer);
        if (!frame) break;
        buffer = buffer.subarray(frame.frameLength);

        if (frame.opcode === 0x8) {
          // close frame من العميل
          listeners.close.forEach((cb) => cb());
          socket.end();
          return;
        }
        if (frame.opcode === 0x1) {
          // text frame
          const text = frame.payload.toString("utf8");
          listeners.message.forEach((cb) => cb(text));
        }
        // 0x9 (ping) / 0xA (pong) بنتجاهلهم — مش حرجين للتجربة دي
      }
    });

    socket.on("close", () => listeners.close.forEach((cb) => cb()));
    socket.on("error", () => listeners.close.forEach((cb) => cb()));

    onConnection(conn, req);
  });
}

module.exports = { attachWebSocketServer };
