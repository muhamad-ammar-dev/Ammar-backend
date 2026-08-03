// src/ws/hub.js
//
// إدارة القنوات (Pub/Sub) بسيطة في الذاكرة. channel -> Set<connection>.
// نفس الفكرة اللي هتستخدمها مع Redis Pub/Sub في الإنتاج (راجع
// tracking-realtime.md) — بس هنا كل حاجة في process واحد، فمش محتاجين Redis
// أصلًا لحد ما يبقى عندك أكتر من سيرفر Backend شغال.

const channels = new Map(); // channel name -> Set<conn>

function subscribe(channel, conn) {
  if (!channels.has(channel)) channels.set(channel, new Set());
  channels.get(channel).add(conn);
}

function unsubscribe(channel, conn) {
  channels.get(channel)?.delete(conn);
}

function unsubscribeAll(conn) {
  for (const subs of channels.values()) subs.delete(conn);
}

function publish(channel, data) {
  const subs = channels.get(channel);
  if (!subs || subs.size === 0) return 0;
  const message = JSON.stringify(data);
  for (const conn of subs) conn.send(message);
  return subs.size;
}

module.exports = { subscribe, unsubscribe, unsubscribeAll, publish };
