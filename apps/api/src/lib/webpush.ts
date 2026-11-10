// Web Push без внешних библиотек: подпись VAPID (RFC 8292) и шифрование содержимого aes128gcm (RFC 8291).
// Текст уведомления шифруется ключом конкретного телефона: сервис доставки (Apple, Google, Mozilla) его не видит.
import { createCipheriv, createECDH, createHmac, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type pg from 'pg';

export type Vapid = { publicKey: string; privatePem: string; subject: string };
export type PushSub = { endpoint: string; p256dh: string; auth: string };
export type PushPayload = { title: string; body: string; url?: string; tag?: string };

const b64u = (b: Buffer) => b.toString('base64url');
const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();

export function generateVapid(): { publicKey: string; privatePem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { publicKey: b64u(raw), privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() };
}

/** Ключи из .env (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY) или из базы; если нет нигде — создаём и сохраняем один раз. */
export async function loadVapid(pool: pg.Pool): Promise<Vapid> {
  const subject = process.env.PUSH_SUBJECT || (process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/$/, '') : 'https://app.amoglobal.ru');
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privatePem: process.env.VAPID_PRIVATE_KEY.replace(/\\n/g, '\n'), subject };
  }
  let row = (await pool.query('select public_key, private_pem from push_config where id = 1')).rows[0];
  if (!row) {
    const k = generateVapid();
    await pool.query('insert into push_config(id, public_key, private_pem) values (1, $1, $2) on conflict (id) do nothing', [k.publicKey, k.privatePem]);
    row = (await pool.query('select public_key, private_pem from push_config where id = 1')).rows[0];
  }
  return { publicKey: row.public_key, privatePem: row.private_pem, subject };
}

function vapidAuth(endpoint: string, v: Vapid) {
  const aud = new URL(endpoint).origin;
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(Buffer.from(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: v.subject })));
  const sig = sign('sha256', Buffer.from(`${header}.${body}`), { key: createPrivateKey(v.privatePem), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${body}.${b64u(sig)}, k=${v.publicKey}`;
}

/** Шифрование по RFC 8291 (одна запись aes128gcm). */
export function encryptPayload(sub: { p256dh: string; auth: string }, plaintext: Buffer, salt = randomBytes(16)) {
  const uaPublic = Buffer.from(sub.p256dh, 'base64url');
  const authSecret = Buffer.from(sub.auth, 'base64url');
  const ecdh = createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const enc = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, enc]);
}

export type SendResult = { ok: boolean; gone: boolean; status: number };

export async function sendPush(fetchFn: typeof fetch, v: Vapid, sub: PushSub, payload: PushPayload, ttl = 3600): Promise<SendResult> {
  const body = encryptPayload(sub, Buffer.from(JSON.stringify(payload)));
  try {
    const res = await fetchFn(sub.endpoint, {
      method: 'POST',
      headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(ttl), Urgency: 'high', Authorization: vapidAuth(sub.endpoint, v) },
      body,
    });
    return { ok: res.status >= 200 && res.status < 300, gone: res.status === 404 || res.status === 410, status: res.status };
  } catch {
    return { ok: false, gone: false, status: 0 };
  }
}
