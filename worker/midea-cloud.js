// Midea SmartHome Cloud kliens (appId 1010). Csak rögzített, engedélyezett végpontokat hív;
// a frontend semmilyen módon nem adhat meg tetszőleges Midea végpontot.
//
// Forrás:
//  - midea-lan/midea-local cloud.py (SmartHomeCloud): útvonalválasztás, bejelentkezés, eszközlista
//  - a904guy/coolth-ac-controller cloud.py: bejelentkezési mezők, aláírás
//  - NEM bizonyított az elsődleges referenciákban: /v1/appliance/transparent/send (SmartHome).
//    Ezt a harmadik fél által írt bootstrap314/ac-man (src/cloud.rs) valósítja meg; lásd README "Ismert hiányosságok".

import {
  APP_ID, APP_KEY, IOT_KEY, aesCbcDecryptHex, aesCbcEncryptHex, deriveSessionKeys,
  deviceIdFor, encryptAccount, encryptIamPassword, encryptPassword, signRequest, toHex,
} from "./authentication.js";

export const DEFAULT_BASE = "https://mp-prod.appsmb.com/mas/v5/app/proxy?alias=";

// Az egyetlen végpontok, amiket a Worker a Midea felé hívhat.
export const ENDPOINTS = Object.freeze({
  ROUTE_NEW: "/v1/unitcenter/router/user/name",
  ROUTE_LEGACY: "/v1/multicloud/platform/user/route",
  LOGIN_ID: "/v1/user/login/id/get",
  LOGIN: "/mj/user/login",
  LIST: "/v1/appliance/user/list/get",
  SEND: "/v1/appliance/transparent/send",
});
const ALLOWED_ENDPOINTS = new Set(Object.values(ENDPOINTS));

// midea-local exceptions.py CLOUD_ERRORS / LOGIN_ERROR_CODES
const AUTH_CODES = new Set([3101, 3102, 3301, 7610, 65027]);
const SESSION_CODES = new Set([3004, 3106, 3144, 3302, 65002, 65006]); // ac-man + midea-local
const TRANSIENT_CODES = new Set([9999]);
const NO_REPLY_CODE = 1306; // ac-man: parancs elfogadva azonnali válasz nélkül
const NOT_OWNER_CODE = 3201;

export class MideaCloudError extends Error {
  /** kind: network | timeout | http | invalid-response | auth | session | not-owner | api | protocol */
  constructor(kind, message, cloudCode = null, networkCode = null) {
    super(message);
    this.name = "MideaCloudError";
    this.kind = kind;
    this.cloudCode = cloudCode;
    this.networkCode = networkCode;
  }
}

export function isAllowedHost(urlString) {
  try {
    const u = new URL(urlString);
    return u.protocol === "https:" && !u.username && !u.password && (u.port === "" || u.port === "443")
      && (u.hostname.endsWith(".appsmb.com") || u.hostname.endsWith(".smartmidea.net"));
  } catch {
    return false;
  }
}

// MIDEA_REGION: "AUTO" (alapértelmezett, fiókalapú útvonalválasztás) vagy egy engedélyezett gateway URL.
export function resolveBase(region) {
  const r = (region || "AUTO").trim();
  if (r.toUpperCase() === "AUTO") return { base: DEFAULT_BASE, discover: true };
  if (isAllowedHost(r)) return { base: normalizeBase(r), discover: false };
  throw new MideaCloudError("protocol", "A MIDEA_REGION értéke csak AUTO vagy engedélyezett https Midea gateway URL lehet.");
}

function normalizeBase(url) {
  const u = new URL(url);
  const path = u.pathname && u.pathname !== "/" ? u.pathname : "/mas/v5/app/proxy";
  return `${u.origin}${path}?alias=`;
}

const stamp = (d) => d.toISOString().replace(/[-:T]/g, "").slice(0, 14);

function randomHex(n) {
  return toHex(crypto.getRandomValues(new Uint8Array(n)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A transzparens küldés szövege: előjeles bájtok vesszővel elválasztva (ac-man send_frame).
export function frameToCsv(bytes) {
  return Array.from(bytes, (b) => (b > 127 ? b - 256 : b)).join(",");
}

export function csvToBytes(csv) {
  const parts = csv.trim().split(",");
  return Uint8Array.from(parts, (p) => {
    const n = Number(p.trim());
    if (p.trim() === "" || !Number.isInteger(n) || n < -128 || n > 255) {
      throw new MideaCloudError("invalid-response", "Érvénytelen bájt a Midea válaszban.");
    }
    return n & 0xff;
  });
}

export class MideaCloud {
  constructor({ account, password, region = "AUTO", fetchImpl = (...a) => fetch(...a), now = () => new Date(), timeoutMs = 10000, retryBackoffMs = 300 }) {
    this.account = account;
    this.password = password;
    this.region = region;
    this.fetch = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.retryBackoffMs = retryBackoffMs;
    this.session = null;
    this.loginPromise = null;
    this.authFailure = null; // { until, error }
    this.deviceId = null;
  }

  // --- HTTP réteg -----------------------------------------------------------
  general(session = this.session) {
    return {
      src: APP_ID, format: "2", stamp: stamp(this.now()), platformId: "1", deviceId: this.deviceId,
      reqId: randomHex(16), uid: session ? session.uid : null, clientType: "1", appId: APP_ID, language: "en_US",
    };
  }

  async request(base, endpoint, data, { session = this.session } = {}) {
    if (!ALLOWED_ENDPOINTS.has(endpoint)) throw new MideaCloudError("protocol", "Nem engedélyezett Midea végpont.");
    if (!isAllowedHost(base)) throw new MideaCloudError("protocol", "Nem engedélyezett Midea szerver címe.");
    const url = new URL(base);
    url.searchParams.set("alias", endpoint);

    const body = JSON.stringify(data);
    const random = String(Math.floor(this.now().getTime() / 1000));
    const headers = {
      "content-type": "application/json; charset=utf-8",
      "x-recipe-app": APP_ID,
      authorization: `Basic ${btoa(`${APP_KEY}:${IOT_KEY}`)}`,
      secretVersion: "1",
      sign: await signRequest(body, random),
      random,
    };
    if (session) {
      headers.uid = session.uid;
      headers.accessToken = session.accessToken;
    }

    let parsed;
    for (let attempt = 0; attempt < 3; attempt++) {
      parsed = await this.post(url.toString(), headers, body);
      if (!TRANSIENT_CODES.has(parsed.code) || attempt === 2) break;
      await sleep(this.retryBackoffMs * (attempt + 1));
    }
    return parsed;
  }

  async post(url, headers, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetch(url, { method: "POST", headers, body, signal: ctrl.signal, redirect: "error" });
    } catch (e) {
      if (e && e.name === "AbortError") throw new MideaCloudError("timeout", "A Midea Cloud nem válaszolt időben.");
      const code = e && e.cause && typeof e.cause.code === "string" ? e.cause.code : "UNKNOWN";
      const networkCode = /^[A-Z0-9_]{1,40}$/.test(code) ? code : "UNKNOWN";
      throw new MideaCloudError("network", "A Midea Cloud nem érhető el.", null, networkCode);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new MideaCloudError("http", `A Midea Cloud HTTP ${res.status} hibát adott.`, res.status);
    let json;
    try {
      json = await res.json();
    } catch {
      throw new MideaCloudError("invalid-response", "A Midea Cloud érvénytelen választ adott.");
    }
    const code = Number.parseInt(json && json.code, 10);
    if (!Number.isInteger(code)) throw new MideaCloudError("invalid-response", "A Midea Cloud válaszából hiányzik az eredménykód.");
    return { code, data: json.data };
  }

  // Sikeres (0) válasz adatát adja, minden más hibakóddal kivételt dob.
  async call(base, endpoint, data, opts) {
    const { code, data: out } = await this.request(base, endpoint, data, opts);
    if (code === 0) return out ?? {};
    throw this.errorFor(code);
  }

  errorFor(code) {
    if (AUTH_CODES.has(code)) return new MideaCloudError("auth", "A Midea fiók hitelesítése sikertelen.", code);
    if (SESSION_CODES.has(code)) return new MideaCloudError("session", "A Midea munkamenet lejárt.", code);
    if (code === NOT_OWNER_CODE) return new MideaCloudError("not-owner", "Az eszköz nem ehhez a Midea fiókhoz tartozik.", code);
    return new MideaCloudError("api", "A Midea Cloud hibát jelzett.", code);
  }

  // --- Bejelentkezés --------------------------------------------------------
  async login() {
    if (this.authFailure && this.authFailure.until > this.now().getTime()) throw this.authFailure.error;
    if (!this.loginPromise) {
      this.loginPromise = this.doLogin()
        .catch((e) => {
          // Hibás jelszóval ne bombázzuk a felhőt (7610: fiókzárolás ~5 perc).
          if (e instanceof MideaCloudError && e.kind === "auth") {
            this.authFailure = { until: this.now().getTime() + 60000, error: e };
          }
          throw e;
        })
        .finally(() => { this.loginPromise = null; });
    }
    return this.loginPromise;
  }

  async ensureSession() {
    return this.session || this.login();
  }

  async doLogin() {
    this.session = null;
    this.deviceId = await deviceIdFor(this.account);
    const { base: initialBase, discover } = resolveBase(this.region);
    let base = initialBase;

    if (discover) base = (await this.discoverBase(initialBase)) || initialBase;

    const { loginId } = await this.call(base, ENDPOINTS.LOGIN_ID, { ...this.general(null), loginAccount: this.account }, { session: null });
    if (!loginId) throw new MideaCloudError("invalid-response", "A Midea Cloud nem adott loginId-t.");

    const iotData = this.general(null);
    delete iotData.uid;
    const st = stamp(this.now());
    Object.assign(iotData, {
      iampwd: await encryptIamPassword(loginId, this.password),
      loginAccount: this.account,
      password: await encryptPassword(loginId, this.password),
      stamp: st,
    });
    const r = await this.call(base, ENDPOINTS.LOGIN, {
      iotData,
      data: { appKey: APP_KEY, deviceId: this.deviceId, platform: "2" },
      stamp: st,
    }, { session: null });

    if (!r.uid || !r.mdata || !r.mdata.accessToken || !r.accessToken || !r.randomData) {
      throw new MideaCloudError("invalid-response", "A Midea bejelentkezési válasz hiányos.");
    }
    let keys;
    try {
      keys = await deriveSessionKeys(r.accessToken, r.randomData);
    } catch {
      throw new MideaCloudError("invalid-response", "A Midea munkamenetkulcs nem fejthető vissza.");
    }
    this.authFailure = null;
    this.session = { base, uid: String(r.uid), accessToken: r.mdata.accessToken, key: keys.key, iv: keys.iv };
    return this.session;
  }

  // midea-local SmartHomeCloud._re_route: először az új, majd a régi végpont. Hiba esetén marad az alapértelmezett.
  async discoverBase(base) {
    const attempts = [
      [ENDPOINTS.ROUTE_NEW, async () => ({ ...this.general(null), clientType: 8, clientSrc: 8, userType: "0", userName: await encryptAccount(this.account) })],
      [ENDPOINTS.ROUTE_LEGACY, async () => ({ ...this.general(null), userType: "0", userName: this.account })],
    ];
    for (const [endpoint, build] of attempts) {
      try {
        const { code, data } = await this.request(base, endpoint, await build(), { session: null });
        if (code === 0 && data && data.masUrl && isAllowedHost(data.masUrl)) return normalizeBase(data.masUrl);
      } catch (e) {
        if (e instanceof MideaCloudError && (e.kind === "network" || e.kind === "timeout")) throw e;
      }
    }
    return null;
  }

  // Munkamenet-kezelés: lejárt munkamenetnél egyszer újra bejelentkezik.
  async withSession(fn) {
    let session = await this.ensureSession();
    try {
      return await fn(session);
    } catch (e) {
      if (!(e instanceof MideaCloudError) || e.kind !== "session") throw e;
      this.session = null;
      session = await this.login();
      return fn(session);
    }
  }

  // --- Eszközök -------------------------------------------------------------
  async listAppliances() {
    return this.withSession(async (s) => {
      const data = await this.call(s.base, ENDPOINTS.LIST, this.general(s), { session: s });
      if (!Array.isArray(data.list)) throw new MideaCloudError("invalid-response", "A Midea Cloud nem adott eszközlistát.");
      return data.list.map((a) => ({
        id: String(a.id),
        name: typeof a.name === "string" && a.name ? a.name : `Eszköz ${a.id}`,
        type: parseType(a.type),
        online: String(a.onlineStatus) === "1",
        modelNumber: a.modelNumber ?? null,
      }));
    });
  }

  // Nyers eszközkeret küldése; az azonnali válaszkeretet (ha van) adja vissza, különben null.
  async sendFrame(applianceId, frame) {
    if (!/^\d{1,20}$/.test(String(applianceId))) throw new MideaCloudError("protocol", "Érvénytelen eszközazonosító.");
    return this.withSession(async (s) => {
      const order = await aesCbcEncryptHex(frameToCsv(frame), s.key, s.iv);
      const body = { ...this.general(s), applianceCode: String(applianceId), order, timestamp: "true", isFull: "false" };
      const { code, data } = await this.request(s.base, ENDPOINTS.SEND, body, { session: s });
      if (code === NO_REPLY_CODE) return null;
      if (code !== 0) throw this.errorFor(code);
      const reply = data && data.reply;
      if (!reply) return null;
      let csv;
      try {
        csv = await aesCbcDecryptHex(reply, s.key, s.iv);
      } catch {
        throw new MideaCloudError("invalid-response", "A klíma válasza nem fejthető vissza.");
      }
      return extractFrame(csvToBytes(csv));
    });
  }
}

function parseType(t) {
  if (typeof t === "number") return t;
  const s = String(t).trim();
  const n = /^0x/i.test(s) ? parseInt(s, 16) : parseInt(s, 10);
  return Number.isInteger(n) ? n : null;
}

// A válasz 5A5A burkolót tartalmazhat (40 bájt); az AA keretet adjuk vissza.
export function extractFrame(bytes) {
  let b = bytes;
  if (b.length >= 40 && b[0] === 0x5a && b[1] === 0x5a) b = b.slice(40);
  if (b.length < 2 || b[0] !== 0xaa) throw new MideaCloudError("invalid-response", "Ismeretlen klímaválasz formátum.");
  const len = b[1] + 1;
  if (b.length < len) throw new MideaCloudError("invalid-response", "Csonka klímaválasz.");
  return b.slice(0, len);
}
