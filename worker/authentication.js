// Kriptográfiai és hitelesítési primitívek a Midea SmartHome (appId 1010) protokollhoz.
// Forrás (portolva, nem kitalálva):
//  - midea-lan/midea-local: midealocal/security.py (CloudSecurity, MSmartCloudSecurity), cloud.py
//  - a904guy/coolth-ac-controller: coolth/cloud.py (SmartHomeCloud._Security)
// A Web Crypto API-t használja (Workers és Node is), az MD5-öt kézzel kell megvalósítani,
// mert a Web Crypto nem támogatja.

export const APP_ID = "1010";
export const APP_KEY = "ac21b9f9cbfe4ca5a88562ef25e2b768"; // "login key" és AES-kulcs alap
export const IOT_KEY = "meicloud";
export const HMAC_KEY = "PROD_VnoClJI9aikS8dyy";

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

export function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
    throw new Error("Érvénytelen hexadecimális adat.");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export async function sha256Hex(text) {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text))));
}

export async function hmacSha256Hex(key, message) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(message))));
}

// --- MD5 (RFC 1321) ---------------------------------------------------------
const MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export function md5Hex(text) {
  const msg = enc.encode(text);
  const bitLen = msg.length * 8;
  const padded = new Uint8Array(((msg.length + 8) >> 6 << 6) + 64);
  padded.set(msg);
  padded[msg.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bitLen >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bitLen / 2 ** 32), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < padded.length; off += 64) {
    const m = new Uint32Array(16);
    for (let i = 0; i < 16; i++) m[i] = view.getUint32(off + i * 4, true);
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      f = (f + a + MD5_K[i] + m[g]) >>> 0;
      a = d; d = c; c = b;
      b = (b + ((f << MD5_S[i]) | (f >>> (32 - MD5_S[i])))) >>> 0;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((v, i) => ov.setUint32(i * 4, v, true));
  return toHex(out);
}

// --- AES-CBC (kulcs és IV ASCII szövegként, PKCS7, hex kimenet) -------------
async function aesKey(key, usage) {
  return crypto.subtle.importKey("raw", enc.encode(key), { name: "AES-CBC" }, false, [usage]);
}

export async function aesCbcEncryptHex(plainText, key, iv) {
  const ct = await crypto.subtle.encrypt({ name: "AES-CBC", iv: enc.encode(iv) }, await aesKey(key, "encrypt"), enc.encode(plainText));
  return toHex(new Uint8Array(ct));
}

export async function aesCbcDecryptHex(cipherHex, key, iv) {
  const pt = await crypto.subtle.decrypt({ name: "AES-CBC", iv: enc.encode(iv) }, await aesKey(key, "decrypt"), fromHex(cipherHex));
  return dec.decode(pt);
}

// --- SmartHome hitelesítés ---------------------------------------------------

// HMAC-SHA256(HMAC_KEY, IOT_KEY + body + random)
export function signRequest(body, random) {
  return hmacSha256Hex(HMAC_KEY, IOT_KEY + body + random);
}

// "password" mező: sha256(loginId + sha256(password) + APP_KEY)
export async function encryptPassword(loginId, password) {
  return sha256Hex(loginId + (await sha256Hex(password)) + APP_KEY);
}

// "iampwd" mező: sha256(loginId + md5(md5(password)) + APP_KEY)
export async function encryptIamPassword(loginId, password) {
  return sha256Hex(loginId + md5Hex(md5Hex(password)) + APP_KEY);
}

async function tempKeyIv() {
  const digest = await sha256Hex(APP_KEY);
  return { key: digest.slice(0, 16), iv: digest.slice(16, 32) };
}

// A bejelentkezési válasz accessToken/randomData mezőjéből a munkamenet AES kulcsa és IV-je.
export async function deriveSessionKeys(encryptedKeyHex, encryptedIvHex) {
  const t = await tempKeyIv();
  return {
    key: await aesCbcDecryptHex(encryptedKeyHex, t.key, t.iv),
    iv: await aesCbcDecryptHex(encryptedIvHex, t.key, t.iv),
  };
}

// Fiókrouting végpont (/v1/unitcenter/router/user/name) titkosított fióknév mezője.
export async function encryptAccount(account) {
  const t = await tempKeyIv();
  return aesCbcEncryptHex(account, t.key, t.iv);
}

// Determinisztikus eszközazonosító (midea-local: CloudSecurity.get_deviceid).
// Állandó, így a hideg indítások nem regisztrálnak újabb "bejelentkezett eszközt".
export async function deviceIdFor(account) {
  return (await sha256Hex(`Hello, ${account}!`)).slice(0, 16);
}

// Időzítés-támadás ellen védett összehasonlítás (az ACCESS_TOKEN ellenőrzéséhez).
export async function timingSafeEqualStrings(a, b) {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(String(a))),
    crypto.subtle.digest("SHA-256", enc.encode(String(b))),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
