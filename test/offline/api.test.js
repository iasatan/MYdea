// MOCK alapú API-tesztek: a Worker teljes kérés-útvonalát futtatják szimulált Midea Cloud ellen.
// FIGYELEM: ez NEM igazolja a valódi Midea Cloud kapcsolatot (lásd test/live/).
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../../worker/index.js";
import { ACCOUNT, APPLIANCE_ID, PASSWORD, createMockCloud } from "./mock-cloud.js";

const ORIGIN = "https://user.github.io";
const TOKEN = "t".repeat(40);
const env = { ACCESS_TOKEN: TOKEN, ALLOWED_ORIGIN: ORIGIN };
const accountHeaders = { "x-midea-user": ACCOUNT, "x-midea-password": PASSWORD, "x-midea-region": "AUTO" };

function setup(opts = {}, envOverride = {}) {
  const mock = createMockCloud(opts);
  const app = createApp({ fetchImpl: mock.fetch });
  const call = async (method, path, body, { origin = ORIGIN, token = TOKEN, headers = {} } = {}) => {
    const h = { ...accountHeaders, ...headers };
    if (origin) h.origin = origin;
    if (token) h.authorization = `Bearer ${token}`;
    if (body !== undefined) h["content-type"] = "application/json";
    const res = await app(new Request(`https://worker.test${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), { ...env, ...envOverride });
    const text = await res.text();
    return { res, text, json: text ? JSON.parse(text) : null };
  };
  return { mock, call };
}

test("SmartHome bejelentkezés + eszközlista", async () => {
  const { mock, call } = setup();
  const { res, json } = await call("GET", "/api/devices");
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.data.devices[0].id, APPLIANCE_ID);
  assert.equal(json.data.devices[0].name, "Nappali klíma");
  assert.equal(json.data.selectedId, APPLIANCE_ID);
  assert.equal(mock.loginCount, 1);
});

test("állapotlekérdezés", async () => {
  const { call } = setup();
  const { res, json } = await call("GET", "/api/status");
  assert.equal(res.status, 200);
  const d = json.data;
  assert.equal(d.power, true);
  assert.equal(d.mode, "COOL");
  assert.equal(d.targetTemperature, 21);
  assert.equal(d.device.online, true);
  assert.equal(d.capabilities.source, "device");
  assert.ok(d.queriedAt);
});

test("kikapcsolás majd bekapcsolás", async () => {
  const { call } = setup();
  let r = await call("POST", "/api/power", { on: false });
  assert.equal(r.json.data.power, false);
  assert.equal(r.json.data.confirmed, true);
  r = await call("POST", "/api/power", { on: true });
  assert.equal(r.json.data.power, true);
  assert.equal(r.json.data.confirmed, true);
});

test("fűtési és hűtési mód", async () => {
  const { call } = setup();
  let r = await call("POST", "/api/mode", { mode: "HEAT" });
  assert.equal(r.res.status, 200);
  assert.equal(r.json.data.mode, "HEAT");
  r = await call("POST", "/api/mode", { mode: "COOL" });
  assert.equal(r.json.data.mode, "COOL");
  assert.equal(r.json.data.confirmed, true);
});

test("hőmérséklet-beállítás és tartomány", async () => {
  const { call } = setup();
  let r = await call("POST", "/api/temperature", { temperature: 24.5 });
  assert.equal(r.json.data.targetTemperature, 24.5);
  r = await call("POST", "/api/temperature", { temperature: 35 });
  assert.equal(r.res.status, 400);
  assert.equal(r.json.error.code, "TEMPERATURE_OUT_OF_RANGE");
  r = await call("POST", "/api/temperature", { temperature: "24" });
  assert.equal(r.res.status, 400);
});

test("ventilátorsebesség", async () => {
  const { call } = setup();
  let r = await call("POST", "/api/fan", { level: 40 });
  assert.equal(r.res.status, 200);
  assert.equal(r.json.data.fan.raw, 40);
  assert.equal(r.json.data.confirmed, true);
  r = await call("POST", "/api/fan", { speed: "auto" });
  assert.equal(r.res.status === 200 || r.res.status === 400, true);
  r = await call("POST", "/api/fan", { level: 0 });
  assert.equal(r.res.status, 400);
});

test("a módosítás megőrzi a többi beállítást (olvasás-módosítás-írás)", async () => {
  const { call, mock } = setup();
  await call("POST", "/api/temperature", { temperature: 26 });
  const before = (await call("GET", "/api/status")).json.data;
  await call("POST", "/api/power", { on: false });
  const after = (await call("GET", "/api/status")).json.data;
  assert.equal(after.targetTemperature, before.targetTemperature);
  assert.equal(after.mode, before.mode);
  assert.equal(after.fan.raw, before.fan.raw);
  assert.ok(mock.sent.length > 0);
});

test("hibás hitelesítés (Midea jelszó)", async () => {
  const mock = createMockCloud();
  mock.password = "mas-jelszo";
  const app = createApp({ fetchImpl: mock.fetch });
  const res = await app(new Request("https://worker.test/api/devices", { headers: { origin: ORIGIN, authorization: `Bearer ${TOKEN}`, ...accountHeaders } }), env);
  const json = await res.json();
  assert.equal(res.status, 502);
  assert.equal(json.error.code, "CLOUD_AUTH_FAILED");
  assert.ok(!JSON.stringify(json).includes(PASSWORD));
});

test("Midea Cloud elérhetetlen", async () => {
  const { mock, call } = setup();
  mock.unreachable = true;
  const { res, json } = await call("GET", "/api/status");
  assert.equal(res.status, 504);
  assert.equal(json.error.code, "CLOUD_UNREACHABLE");
});

test("offline klíma: állapot online=false, vezérlés 409", async () => {
  const { call } = setup({ devices: [{ id: APPLIANCE_ID, name: "K", type: "0xAC", onlineStatus: "0" }] });
  const s = await call("GET", "/api/status");
  assert.equal(s.json.data.device.online, false);
  const p = await call("POST", "/api/power", { on: true });
  assert.equal(p.res.status, 409);
});

test("API-token, eredet és bemenet ellenőrzése", async () => {
  const { call } = setup();
  assert.equal((await call("GET", "/api/status", undefined, { token: null })).res.status, 401);
  assert.equal((await call("GET", "/api/status", undefined, { token: "rossz" })).res.status, 401);
  assert.equal((await call("GET", "/api/status", undefined, { origin: "https://evil.example" })).res.status, 403);
  assert.equal((await call("POST", "/api/power", { on: true }, { origin: null })).res.status, 403);
  assert.equal((await call("POST", "/api/power", { on: "yes" })).res.status, 400);
  assert.equal((await call("POST", "/api/power", { on: true, x: 1 })).res.status, 400);
  assert.equal((await call("POST", "/api/mode", { mode: "TURBO" })).res.status, 400);
  assert.equal((await call("GET", "/api/status", undefined, { headers: { "x-appliance-id": "abc" } })).res.status, 400);
  assert.equal((await call("GET", "/api/nincs")).res.status, 404);
  assert.equal((await call("GET", "/api/power")).res.status, 405);
});

test("CORS: csak a konfigurált eredet, preflight", async () => {
  const { call } = setup();
  const ok = await call("OPTIONS", "/api/power");
  assert.equal(ok.res.status, 204);
  assert.equal(ok.res.headers.get("access-control-allow-origin"), ORIGIN);
  const no = await call("OPTIONS", "/api/power", undefined, { origin: "https://evil.example" });
  assert.equal(no.res.status, 403);
  assert.equal(no.res.headers.get("access-control-allow-origin"), null);
});

test("hiányzó Worker konfiguráció: 500, titok nélkül", async () => {
  const { call } = setup({}, { ACCESS_TOKEN: "" });
  const { res, json } = await call("GET", "/api/status");
  assert.equal(res.status, 500);
  assert.match(json.error.message, /ACCESS_TOKEN/);
});

test("hiányzó készüléki Midea hitelesítés: 400", async () => {
  const { call } = setup();
  const { res, json } = await call("GET", "/api/status", undefined, {
    headers: { "x-midea-user": "", "x-midea-password": "" },
  });
  assert.equal(res.status, 400);
  assert.equal(json.error.code, "MIDEA_CREDENTIALS_REQUIRED");
});

test("a válaszokban nincs jelszó vagy token", async () => {
  const { call } = setup();
  for (const [m, p, b] of [["GET", "/api/devices"], ["GET", "/api/status"], ["POST", "/api/power", { on: true }]]) {
    const { text: t } = await call(m, p, b);
    assert.ok(!t.includes(PASSWORD) && !t.includes(TOKEN) && !t.includes("mock-access-token"));
  }
});
