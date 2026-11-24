// Cloudflare Worker belépési pont: REST API, CORS, hitelesítés, bemenet-ellenőrzés, hibakezelés.
// Nincs ütemezett feladat (Cron Trigger) és nincs háttérautomatizmus: minden művelet kézi kérésre fut.

import { timingSafeEqualStrings } from "./authentication.js";
import { ApiError, DeviceService } from "./device.js";
import { MideaCloud, MideaCloudError } from "./midea-cloud.js";

const MAX_BODY_BYTES = 1024;
const MODES = ["AUTO", "COOL", "HEAT", "DRY", "FAN"];
const FAN_NAMES = ["auto", "silent", "low", "medium", "high", "max"];
const REQUIRED_ENV = ["ACCESS_TOKEN", "ALLOWED_ORIGIN"];

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extraHeaders },
  });
}

const fail = (status, code, message, headers) => json(status, { ok: false, error: { code, message } }, headers);

function corsHeaders(origin) {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-appliance-id, x-midea-user, x-midea-password, x-midea-region",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

// Az eredet egyetlen, konfigurált GitHub Pages originnel vethető össze (útvonal nélkül).
export function normalizeOrigin(value) {
  try {
    const u = new URL(String(value).trim());
    if (u.protocol !== "https:" && !(u.protocol === "http:" && u.hostname === "localhost")) return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function mapError(e) {
  if (e instanceof ApiError) return { status: e.status, code: e.code, message: e.message };
  if (e instanceof MideaCloudError) {
    switch (e.kind) {
      case "network": return { status: 504, code: "CLOUD_UNREACHABLE", message: "A Midea Cloud nem érhető el. Próbáld újra később." };
      case "timeout": return { status: 504, code: "CLOUD_TIMEOUT", message: "A Midea Cloud nem válaszolt időben." };
      case "auth": return { status: 502, code: "CLOUD_AUTH_FAILED", message: `A Midea fiók hitelesítése sikertelen (kód: ${e.cloudCode}). Ellenőrizd a Worker titkait.` };
      case "not-owner": return { status: 403, code: "DEVICE_NOT_OWNED", message: "Az eszköz nem ehhez a Midea fiókhoz tartozik." };
      case "protocol": return { status: 500, code: "SERVER_MISCONFIGURED", message: e.message };
      default: return { status: 502, code: "CLOUD_ERROR", message: `A Midea Cloud hibát jelzett${e.cloudCode ? ` (kód: ${e.cloudCode})` : ""}.` };
    }
  }
  return { status: 500, code: "INTERNAL_ERROR", message: "Váratlan belső hiba." };
}

async function readJson(request) {
  const type = request.headers.get("content-type") || "";
  if (!/^application\/json\b/i.test(type)) throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "A kérés Content-Type értéke application/json kell legyen.");
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new ApiError(413, "BODY_TOO_LARGE", "A kérés törzse túl nagy.");
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ApiError(400, "INVALID_JSON", "A kérés törzse nem érvényes JSON.");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "INVALID_BODY", "A kérés törzse JSON objektum kell legyen.");
  return body;
}

const bad = (message) => new ApiError(400, "INVALID_INPUT", message);

function onlyKeys(body, allowed) {
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw bad(`Ismeretlen mező: ${k}`);
}

export const validators = {
  power(body) {
    onlyKeys(body, ["on"]);
    if (typeof body.on !== "boolean") throw bad("Az 'on' mező logikai érték (true/false) kell legyen.");
    return body.on;
  },
  mode(body) {
    onlyKeys(body, ["mode"]);
    const m = typeof body.mode === "string" ? body.mode.toUpperCase() : "";
    if (!MODES.includes(m)) throw bad(`A 'mode' értéke ezek egyike lehet: ${MODES.join(", ")}.`);
    return m;
  },
  temperature(body) {
    onlyKeys(body, ["temperature"]);
    const t = body.temperature;
    if (typeof t !== "number" || !Number.isFinite(t) || t < 10 || t > 40) throw bad("A 'temperature' érvényes szám (°C) kell legyen.");
    return t;
  },
  fan(body) {
    onlyKeys(body, ["speed", "level"]);
    const hasSpeed = body.speed !== undefined;
    const hasLevel = body.level !== undefined;
    if (hasSpeed === hasLevel) throw bad("Pontosan egyet adj meg: 'speed' vagy 'level'.");
    if (hasSpeed) {
      if (typeof body.speed !== "string" || !FAN_NAMES.includes(body.speed.toLowerCase())) throw bad(`A 'speed' értéke ezek egyike lehet: ${FAN_NAMES.join(", ")}.`);
      return { speed: body.speed.toLowerCase() };
    }
    if (!Number.isInteger(body.level) || body.level < 1 || body.level > 100) throw bad("A 'level' 1 és 100 közötti egész szám kell legyen.");
    return { level: body.level };
  },
};

export function createApp({ fetchImpl, now } = {}) {
  function serviceFor(env, credentials) {
    const cloud = new MideaCloud({
      account: credentials.user,
      password: credentials.password,
      region: credentials.region,
      fetchImpl,
      now,
    });
    return new DeviceService({ cloud, defaultApplianceId: env.APPLIANCE_ID, now });
  }

  async function route(request, env, url, requestedId, credentials) {
    const path = url.pathname;
    const method = request.method;
    const routes = {
      "/api/status": "GET", "/api/devices": "GET",
      "/api/power": "POST", "/api/mode": "POST", "/api/temperature": "POST", "/api/fan": "POST",
    };
    if (!(path in routes)) throw new ApiError(404, "NOT_FOUND", "Ismeretlen végpont.");
    if (routes[path] !== method) throw new ApiError(405, "METHOD_NOT_ALLOWED", "Nem engedélyezett HTTP metódus.");

    const svc = serviceFor(env, credentials);
    switch (path) {
      case "/api/devices": return svc.listDevices(requestedId);
      case "/api/status": return svc.getStatus(requestedId);
      default: {
        const body = await readJson(request);
        if (path === "/api/power") return svc.setPower(requestedId, validators.power(body));
        if (path === "/api/mode") return svc.setMode(requestedId, validators.mode(body));
        if (path === "/api/temperature") return svc.setTemperature(requestedId, validators.temperature(body));
        return svc.setFan(requestedId, validators.fan(body));
      }
    }
  }

  return async function handle(request, env) {
    const allowed = normalizeOrigin(env.ALLOWED_ORIGIN || "");
    const origin = request.headers.get("origin");
    const cors = origin && allowed && origin === allowed ? corsHeaders(origin) : {};

    try {
      const missing = REQUIRED_ENV.filter((k) => !env[k]);
      if (missing.length || !allowed) {
        throw new ApiError(500, "SERVER_MISCONFIGURED", `A Worker konfigurációja hiányos: ${missing.length ? missing.join(", ") : "ALLOWED_ORIGIN"}.`);
      }
      if (origin && origin !== allowed) throw new ApiError(403, "ORIGIN_NOT_ALLOWED", "Ez az eredet nem engedélyezett.");

      if (request.method === "OPTIONS") {
        if (!origin) throw new ApiError(403, "ORIGIN_REQUIRED", "Az Origin fejléc kötelező.");
        return new Response(null, { status: 204, headers: cors });
      }
      if (request.method === "POST" && !origin) throw new ApiError(403, "ORIGIN_REQUIRED", "POST kéréshez az Origin fejléc kötelező.");

      const auth = request.headers.get("authorization") || "";
      const match = /^Bearer (.+)$/.exec(auth);
      if (!match || !(await timingSafeEqualStrings(match[1], env.ACCESS_TOKEN))) {
        throw new ApiError(401, "UNAUTHORIZED", "Hiányzó vagy érvénytelen hozzáférési token.");
      }

      const url = new URL(request.url);
      const requestedId = request.headers.get("x-appliance-id") || url.searchParams.get("deviceId") || "";
      if (requestedId && !/^\d{1,20}$/.test(requestedId)) throw new ApiError(400, "INVALID_DEVICE_ID", "Érvénytelen eszközazonosító.");

      const credentials = {
        user: (request.headers.get("x-midea-user") || "").trim(),
        password: request.headers.get("x-midea-password") || "",
        region: (request.headers.get("x-midea-region") || "AUTO").trim(),
      };
      if (!credentials.user || !credentials.password) {
        throw new ApiError(400, "MIDEA_CREDENTIALS_REQUIRED", "A Midea e-mail-cím és jelszó a készülék beállításaiban kötelező.");
      }

      const data = await route(request, env, url, requestedId, credentials);
      return json(200, { ok: true, data }, cors);
    } catch (e) {
      const m = mapError(e);
      // Csak a hiba kódját naplózzuk, soha nem adatot, jelszót vagy tokent.
      if (m.status >= 500) console.error(`api-error ${m.code} ${e && e.kind ? e.kind : ""} ${e && e.cloudCode ? e.cloudCode : ""}`.trim());
      return fail(m.status, m.code, m.message, cors);
    }
  };
}

let defaultApp = null;

export default {
  async fetch(request, env) {
    defaultApp ??= createApp();
    return defaultApp(request, env);
  },
};
