// Klímamodell: válaszkeretek értelmezése (állapot, képességek) és a magas szintű műveletek.
// Az értelmezés pontos portja a coolth/device/AC/command.py (StateResponse, CapabilitiesResponse) kódnak.

import {
  DEVICE_TYPE_AC, buildCapabilitiesQuery, buildSetState, buildStateQuery, checksum, crc8,
} from "./commands.js";
import { MideaCloudError } from "./midea-cloud.js";

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export const MODES = Object.freeze({ AUTO: 1, COOL: 2, DRY: 3, HEAT: 4, FAN: 5 });
const MODE_NAMES = { 1: "AUTO", 2: "COOL", 3: "DRY", 4: "HEAT", 5: "FAN", 6: "SMART_DRY" };

export const FAN_SPEEDS = Object.freeze({ auto: 102, max: 100, high: 80, medium: 60, low: 40, silent: 20 });
const FAN_ORDER = ["auto", "silent", "low", "medium", "high", "max"];
const SWING_NAMES = { 0: "off", 0xc: "vertical", 0x3: "horizontal", 0xf: "both" };
const DEFAULT_FANS = ["auto", "low", "medium", "high"];
const DEFAULT_RANGE = { min: 17, max: 30 };

const RESP_STATE = 0xc0;
const RESP_CAPABILITIES = 0xb5;

// --- Válaszkeretek -------------------------------------------------------------

export function parseResponse(frame) {
  if (!(frame instanceof Uint8Array) || frame.length < 13) throw new MideaCloudError("invalid-response", "Túl rövid klímaválasz.");
  if (frame[frame.length - 1] !== checksum(frame.slice(1, -1))) throw new MideaCloudError("invalid-response", "A klímaválasz ellenőrzőösszege hibás.");
  if (frame[2] !== DEVICE_TYPE_AC) throw new MideaCloudError("invalid-response", "A válasz nem klímától származik.");

  const frameType = frame[9];
  const id = frame[10];
  const payload = frame.slice(10, -2); // azonosító + adat + üzenetazonosító
  const crc = frame[frame.length - 2];
  if (crc !== crc8(payload) && crc !== checksum(payload)) throw new MideaCloudError("invalid-response", "A klímaválasz CRC-je hibás.");

  if (id === RESP_STATE) return { kind: "state", state: parseState(payload) };
  if (id === RESP_CAPABILITIES && frameType === 0x03) return { kind: "capabilities", ...parseCapabilities(payload) };
  return { kind: "other", id };
}

function parseTemperature(data, decimals, fahrenheit) {
  if (data === 0xff) return null;
  const t = (data - 50) / 2;
  if (!fahrenheit && decimals) return Math.trunc(t) + (t >= 0 ? decimals : -decimals);
  if (decimals >= 0.5) return Math.trunc(t) + (t >= 0 ? 0.5 : -0.5);
  return t;
}

export function parseState(p) {
  if (p.length < 17) throw new MideaCloudError("invalid-response", "Csonka állapotválasz.");
  const s = {};
  s.powerOn = Boolean(p[1] & 0x1);
  s.targetTemperature = (p[2] & 0xf) + 16 + (p[2] & 0x10 ? 0.5 : 0);
  s.operationalMode = (p[2] >> 5) & 0x7;
  s.fanSpeed = p[3] & 0x7f;
  s.swingMode = p[7] & 0xf;
  s.turbo = Boolean(p[8] & 0x20);
  s.independentAuxHeat = Boolean(p[8] & 0x40);
  s.followMe = Boolean(p[8] & 0x80);
  s.eco = Boolean(p[9] & 0x10);
  s.purifier = Boolean(p[9] & 0x20);
  s.auxHeat = Boolean(p[9] & 0x08);
  s.sleep = Boolean(p[10] & 0x1);
  s.turbo = s.turbo || Boolean(p[10] & 0x2);
  s.fahrenheit = Boolean(p[10] & 0x4);
  s.indoorTemperature = parseTemperature(p[11], (p[15] & 0xf) / 10, s.fahrenheit);
  s.outdoorTemperature = parseTemperature(p[12], (p[15] >> 4) / 10, s.fahrenheit);
  const alt = p[13] & 0x1f;
  if (alt !== 0) s.targetTemperature = alt + 12 + (p[2] & 0x10 ? 0.5 : 0);
  s.filterAlert = Boolean(p[13] & 0x20);
  s.displayOn = p[14] !== 0x70;
  s.errorCode = p[16];
  s.targetHumidity = p.length >= 20 ? p[19] & 0x7f : null;
  s.freezeProtection = p.length >= 22 ? Boolean(p[21] & 0x80) : null;
  return s;
}

const anyOf = (list) => (v) => list.includes(v[0]);
const is = (x) => (v) => v[0] === x;

const CAPABILITY_READERS = {
  0x0018: [["breezeless", is(1)]],
  0x0009: [["swing_vertical_angle", is(1)]],
  0x000a: [["swing_horizontal_angle", is(1)]],
  0x0210: [
    ["fan_silent", anyOf([6, 9])], ["fan_low", anyOf([3, 4, 5, 6, 7, 9])], ["fan_medium", anyOf([5, 6, 7])],
    ["fan_high", anyOf([3, 4, 5, 6, 7, 9])], ["fan_auto", anyOf([4, 5, 6, 9])], ["fan_custom", is(1)],
  ],
  0x0214: [
    ["heat_mode", anyOf([1, 2, 4, 6, 7, 9, 10, 11, 12, 13])],
    ["cool_mode", anyOf([0, 1, 3, 4, 5, 6, 7, 8, 9, 11, 13, 14, 15])],
    ["dry_mode", anyOf([0, 1, 5, 6, 9, 11, 13, 14, 15])],
    ["auto_mode", anyOf([0, 1, 2, 7, 8, 9, 13, 14])],
  ],
  0x0215: [["swing_horizontal", anyOf([1, 3])], ["swing_vertical", anyOf([0, 1])]],
  0x0212: [["eco", anyOf([1, 2])]],
  0x021a: [["turbo_heat", anyOf([1, 3])], ["turbo_cool", anyOf([0, 1])]],
};

export function parseCapabilities(p) {
  const raw = {};
  const count = p[1];
  let caps = p.slice(2);
  for (let i = 0; i < count; i++) {
    if (caps.length < 3) break;
    const size = caps[2];
    if (size === 0) { caps = caps.slice(3); continue; }
    const id = caps[0] | (caps[1] << 8);
    const value = caps.slice(3, 3 + size);
    if (CAPABILITY_READERS[id]) {
      for (const [name, read] of CAPABILITY_READERS[id]) raw[name] = read(value);
    } else if (id === 0x0225 && size >= 6) {
      raw.cool_min_temperature = caps[3] * 0.5;
      raw.cool_max_temperature = caps[4] * 0.5;
      raw.auto_min_temperature = caps[5] * 0.5;
      raw.auto_max_temperature = caps[6] * 0.5;
      raw.heat_min_temperature = caps[7] * 0.5;
      raw.heat_max_temperature = caps[8] * 0.5;
      raw.decimals = (size > 6 ? caps[9] : caps[2]) !== 0;
    }
    caps = caps.slice(3 + size);
  }
  const additional = caps.length > 1 ? Boolean(caps[caps.length - 2]) : false;
  return { raw, additional };
}

// A nyers képességekből az API-nak szánt leírás. Ha a klíma nem adott adatot, biztonságos
// alapértékek érvényesek, és a `source` értéke "default".
export function describeCapabilities(raw, source = "device") {
  const has = (prefix) => Object.keys(raw).some((k) => k.startsWith(prefix));
  const modesKnown = ["heat_mode", "cool_mode", "dry_mode", "auto_mode"].some((k) => k in raw);
  const modes = modesKnown
    ? ["AUTO", "COOL", "HEAT", "DRY", "FAN"].filter((m) => m === "FAN" || raw[`${m.toLowerCase()}_mode`])
    : ["AUTO", "COOL", "HEAT", "DRY", "FAN"];

  let fanSpeeds;
  const customFan = Boolean(raw.fan_custom);
  if (has("fan_")) {
    fanSpeeds = FAN_ORDER.filter((n) => (n === "max" ? customFan : n === "auto" ? raw.fan_auto || customFan : raw[`fan_${n}`] || customFan));
  } else {
    fanSpeeds = DEFAULT_FANS;
  }

  const range = (m) => {
    const min = raw[`${m}_min_temperature`];
    const max = raw[`${m}_max_temperature`];
    return min !== undefined && max !== undefined && max > min ? { min, max } : { ...DEFAULT_RANGE };
  };
  const byMode = { COOL: range("cool"), AUTO: range("auto"), HEAT: range("heat") };
  const overall = {
    min: Math.min(...Object.values(byMode).map((r) => r.min)),
    max: Math.max(...Object.values(byMode).map((r) => r.max)),
  };
  const swingModes = ["off"];
  if (raw.swing_horizontal) swingModes.push("horizontal");
  if (raw.swing_vertical) swingModes.push("vertical");
  if (raw.swing_horizontal && raw.swing_vertical) swingModes.push("both");

  return {
    source,
    modes,
    fanSpeeds,
    customFan,
    temperature: { ...overall, step: raw.decimals === true ? 0.5 : 1, byMode: { ...byMode } },
    swingModes,
    breezeless: Boolean(raw.breezeless),
  };
}

export function rangeForMode(caps, modeName) {
  return caps.temperature.byMode[modeName] || { min: caps.temperature.min, max: caps.temperature.max };
}

// --- Állapot az API számára -------------------------------------------------------

export function fanFromRaw(raw) {
  const name = Object.keys(FAN_SPEEDS).find((k) => FAN_SPEEDS[k] === raw);
  return { speed: name || "custom", raw };
}

export function publicState(state, caps) {
  const mode = MODE_NAMES[state.operationalMode] || "UNKNOWN";
  return {
    power: state.powerOn,
    mode,
    targetTemperature: state.targetTemperature,
    indoorTemperature: state.indoorTemperature,
    outdoorTemperature: state.outdoorTemperature,
    fan: fanFromRaw(state.fanSpeed),
    swing: SWING_NAMES[state.swingMode] || "unknown",
    breezeless: caps.breezeless,
    eco: state.eco,
    errorCode: state.errorCode,
    filterAlert: state.filterAlert,
  };
}

// --- Műveletek --------------------------------------------------------------------

const AC_TYPE = DEVICE_TYPE_AC;

export class DeviceService {
  constructor({ cloud, defaultApplianceId = "", now = () => new Date(), capabilityTtlMs = 6 * 3600 * 1000 }) {
    this.cloud = cloud;
    this.defaultApplianceId = (defaultApplianceId || "").trim();
    this.now = now;
    this.capabilityTtlMs = capabilityTtlMs;
    this.capabilityCache = new Map();
  }

  async listDevices(requestedId) {
    const list = await this.cloud.listAppliances();
    const selectedId = this.pickId(list, requestedId, false);
    return {
      selectedId,
      devices: list.map((d) => ({ id: d.id, name: d.name, type: d.type === null ? null : `0x${d.type.toString(16).toUpperCase()}`, online: d.online, supported: d.type === AC_TYPE, selected: d.id === selectedId })),
    };
  }

  // Kiválasztás: kérésben megadott azonosító > APPLIANCE_ID titok > egyetlen klíma a fiókban.
  pickId(list, requestedId, strict = true) {
    const acs = list.filter((d) => d.type === AC_TYPE);
    if (requestedId) {
      if (!list.some((d) => d.id === requestedId)) {
        if (strict) throw new ApiError(404, "DEVICE_NOT_FOUND", "A megadott eszköz nem található a Midea fiókban.");
        return null;
      }
      return requestedId;
    }
    if (this.defaultApplianceId && list.some((d) => d.id === this.defaultApplianceId)) return this.defaultApplianceId;
    if (this.defaultApplianceId && strict) throw new ApiError(404, "DEVICE_NOT_FOUND", "Az APPLIANCE_ID nem szerepel a Midea fiók eszközei között.");
    if (acs.length === 1) return acs[0].id;
    if (strict) throw new ApiError(409, "NO_DEVICE_SELECTED", "Nincs kiválasztott klíma. Válassz eszközt a /api/devices alapján.");
    return null;
  }

  async resolve(requestedId) {
    const list = await this.cloud.listAppliances();
    const id = this.pickId(list, requestedId);
    const device = list.find((d) => d.id === id);
    if (device.type !== AC_TYPE) throw new ApiError(400, "UNSUPPORTED_DEVICE", "A kiválasztott eszköz nem klíma (0xAC).");
    return device;
  }

  async send(device, frame) {
    return this.cloud.sendFrame(device.id, frame);
  }

  async queryState(device) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await this.send(device, buildStateQuery());
      if (!reply) continue;
      const r = parseResponse(reply);
      if (r.kind === "state") return r.state;
    }
    throw new ApiError(504, "DEVICE_NO_RESPONSE", "A klíma nem válaszolt az állapotlekérdezésre.");
  }

  async capabilities(device) {
    const cached = this.capabilityCache.get(device.id);
    if (cached && cached.expires > this.now().getTime()) return cached.caps;

    let caps;
    let ttl = this.capabilityTtlMs;
    try {
      const first = await this.queryCapabilities(device, false);
      if (!first) throw new MideaCloudError("invalid-response", "Nincs képességválasz.");
      const raw = { ...first.raw };
      if (first.additional) {
        const more = await this.queryCapabilities(device, true).catch(() => null);
        if (more) Object.assign(raw, more.raw);
      }
      caps = describeCapabilities(raw, "device");
    } catch (e) {
      if (!(e instanceof MideaCloudError) || e.kind !== "invalid-response") throw e;
      caps = describeCapabilities({}, "default");
      ttl = 60000; // az alapértelmezett leírást hamar újrapróbáljuk
    }
    this.capabilityCache.set(device.id, { caps, expires: this.now().getTime() + ttl });
    return caps;
  }

  async queryCapabilities(device, additional) {
    const reply = await this.send(device, buildCapabilitiesQuery(additional));
    if (!reply) return null;
    const r = parseResponse(reply);
    return r.kind === "capabilities" ? r : null;
  }

  base(device, caps, state) {
    return {
      device: { id: device.id, name: device.name, online: device.online },
      ...publicState(state, caps),
      capabilities: caps,
      queriedAt: this.now().toISOString(),
    };
  }

  async getStatus(requestedId) {
    const device = await this.resolve(requestedId);
    if (!device.online) {
      return { device: { id: device.id, name: device.name, online: false }, offline: true, queriedAt: this.now().toISOString() };
    }
    const caps = await this.capabilities(device);
    const state = await this.queryState(device);
    return this.base(device, caps, state);
  }

  // Olvasás-módosítás-írás: soha nem küld alapértelmezett értékekből épített parancsot.
  async apply(requestedId, change) {
    const device = await this.resolve(requestedId);
    if (!device.online) throw new ApiError(409, "DEVICE_OFFLINE", "A klíma jelenleg offline.");
    const caps = await this.capabilities(device);
    const current = await this.queryState(device);
    const { next, check } = change(current, caps);

    const reply = await this.send(device, buildSetState({ ...next, beepOn: false, forceAuxHeat: false }));
    let after = null;
    if (reply) {
      const r = parseResponse(reply);
      if (r.kind === "state") after = r.state;
    }
    if (!after) after = await this.queryState(device);
    return { ...this.base(device, caps, after), confirmed: check(after) };
  }

  setPower(requestedId, on) {
    return this.apply(requestedId, (s) => ({ next: { ...s, powerOn: on }, check: (a) => a.powerOn === on }));
  }

  setMode(requestedId, mode) {
    return this.apply(requestedId, (s, caps) => {
      if (!caps.modes.includes(mode)) throw new ApiError(400, "UNSUPPORTED_MODE", "A klíma nem támogatja ezt az üzemmódot.");
      const r = rangeForMode(caps, mode);
      const target = Math.min(Math.max(s.targetTemperature, r.min), r.max);
      return { next: { ...s, operationalMode: MODES[mode], targetTemperature: target }, check: (a) => a.operationalMode === MODES[mode] };
    });
  }

  setTemperature(requestedId, value) {
    return this.apply(requestedId, (s, caps) => {
      const modeName = MODE_NAMES[s.operationalMode];
      const r = rangeForMode(caps, modeName);
      const { step } = caps.temperature;
      if (value < r.min || value > r.max) {
        throw new ApiError(400, "TEMPERATURE_OUT_OF_RANGE", `A hőmérséklet ${r.min}–${r.max} °C között állítható.`);
      }
      if (Math.abs(value / step - Math.round(value / step)) > 1e-9) {
        throw new ApiError(400, "INVALID_TEMPERATURE_STEP", `A hőmérséklet lépésköze ${step} °C.`);
      }
      return { next: { ...s, targetTemperature: value }, check: (a) => a.targetTemperature === value };
    });
  }

  setFan(requestedId, { speed, level }) {
    return this.apply(requestedId, (s, caps) => {
      let raw;
      if (speed !== undefined) {
        if (!caps.fanSpeeds.includes(speed)) throw new ApiError(400, "UNSUPPORTED_FAN_SPEED", "A klíma nem támogatja ezt a ventilátorfokozatot.");
        raw = FAN_SPEEDS[speed];
      } else {
        if (!caps.customFan) throw new ApiError(400, "UNSUPPORTED_FAN_SPEED", "A klíma nem támogat egyedi ventilátorfokozatot.");
        raw = level;
      }
      return { next: { ...s, fanSpeed: raw }, check: (a) => a.fanSpeed === raw };
    });
  }
}
