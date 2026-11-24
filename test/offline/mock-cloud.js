// MOCK Midea Cloud + szimulált klíma. Csak a protokoll-logika ellenőrzésére szolgál; NEM valódi Midea kapcsolat.
// A mock valóban ellenőrzi az aláírást, a jelszó-hasheket és visszafejti a titkosított parancsokat.
import { readFileSync } from "node:fs";
import {
  APP_KEY, aesCbcDecryptHex, aesCbcEncryptHex, encryptIamPassword, encryptPassword, fromHex, signRequest, toHex,
} from "../../worker/authentication.js";
import { checksum, crc8 } from "../../worker/commands.js";
import { csvToBytes, frameToCsv } from "../../worker/midea-cloud.js";
import { sha256Hex } from "../../worker/authentication.js";

const golden = JSON.parse(readFileSync(new URL("../fixtures/golden.json", import.meta.url)));
export const ACCOUNT = "user@example.test";
export const PASSWORD = "Example-Only!123";
export const APPLIANCE_ID = "150633094000001";
const SESSION_KEY = "0123456789abcdef";
const SESSION_IV = "fedcba9876543210";
const LOGIN_ID = "mock-login-id";

function seal(bytes) {
  const b = Array.from(bytes);
  b[1] = b.length - 1;
  b[b.length - 2] = crc8(b.slice(10, b.length - 2));
  b[b.length - 1] = checksum(b.slice(1, b.length - 1));
  return Uint8Array.from(b);
}

function mockCaps() {
  const b = fromHex(golden.capabilities[0].frame);
  const hex = toHex(b).replace("14020100", "14020101");
  return seal(fromHex(hex));
}

export function createMockCloud({ devices, behavior = {} } = {}) {
  const ac = fromHex(golden.state[0].frame);
  const st = Array.from(ac);
  st[10 + 1] |= 0x01;
  const mock = {
    calls: [],
    sent: [],
    state: st,
    loginCount: 0,
    devices: devices ?? [{ id: APPLIANCE_ID, name: "Nappali klíma", type: "0xAC", onlineStatus: "1", modelNumber: "Breezeless" }],
    unreachable: false,
    password: PASSWORD,
  };

  const ok = (data) => ({ code: 0, msg: "ok", data });
  const err = (code) => ({ code, msg: "err" });

  async function handleSend(body, headers) {
    if (headers.accessToken !== "mock-access-token") return err(3106);
    const csv = await aesCbcDecryptHex(body.order, SESSION_KEY, SESSION_IV);
    const frame = csvToBytes(csv);
    mock.sent.push(frame);
    if (frame[0] !== 0xaa || frame[frame.length - 1] !== checksum(Array.from(frame).slice(1, -1))) return err(9999 - 1);
    const type = frame[9];
    const id = frame[10];
    let reply = null;
    if (type === 0x03 && id === 0x41) reply = seal(mock.state);
    else if (type === 0x03 && id === 0xb5) reply = mockCaps();
    else if (type === 0x02 && id === 0x40) {
      const p = Array.from(frame);
      // A parancskeret és az állapotkeret mezői azonos pozíciót használnak a bekapcsolás, mód/hőmérséklet, ventilátor bájtoknál.
      mock.state[11] = (mock.state[11] & ~1) | (p[11] & 1);
      mock.state[12] = p[12];
      mock.state[13] = p[13];
      reply = seal(mock.state);
    }
    if (!reply) return err(1306);
    return ok({ reply: await aesCbcEncryptHex(frameToCsv(reply), SESSION_KEY, SESSION_IV) });
  }

  mock.fetch = async (url, init) => {
    if (mock.unreachable) throw new TypeError("fetch failed");
    const u = new URL(url);
    const endpoint = u.searchParams.get("alias");
    const raw = init.body;
    const body = JSON.parse(raw);
    const h = init.headers;
    mock.calls.push(endpoint);
    const respond = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });

    if (!u.hostname.endsWith(".appsmb.com")) throw new Error(`Nem engedélyezett gazda: ${u.hostname}`);
    if (h.sign !== (await signRequest(raw, h.random))) return respond(err(3301));
    if (h["x-recipe-app"] !== "1010") return respond(err(3301));

    switch (endpoint) {
      case "/v1/unitcenter/router/user/name":
      case "/v1/multicloud/platform/user/route":
        return respond(err(9998));
      case "/v1/user/login/id/get":
        return respond(body.loginAccount === ACCOUNT ? ok({ loginId: LOGIN_ID }) : err(3102));
      case "/mj/user/login": {
        const okPw = body.iotData.password === (await encryptPassword(LOGIN_ID, mock.password))
          && body.iotData.iampwd === (await encryptIamPassword(LOGIN_ID, mock.password));
        if (!okPw) return respond(err(3101));
        mock.loginCount++;
        const d = await sha256Hex(APP_KEY);
        const [t, v] = [d.slice(0, 16), d.slice(16, 32)];
        return respond(ok({
          uid: "42", mdata: { accessToken: "mock-access-token" },
          accessToken: await aesCbcEncryptHex(SESSION_KEY, t, v), randomData: await aesCbcEncryptHex(SESSION_IV, t, v),
        }));
      }
      case "/v1/appliance/user/list/get":
        if (h.accessToken !== "mock-access-token") return respond(err(3106));
        return respond(ok({ list: mock.devices }));
      case "/v1/appliance/transparent/send":
        return respond(await handleSend(body, h));
      default:
        return respond(err(404));
    }
  };
  return mock;
}
