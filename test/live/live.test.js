// ÉLES teszt a valódi Midea SmartHome Clouddal. Alapból kihagyott; csak ez igazolhat valódi kapcsolatot.
// Futtatás: MIDEA_USER=... MIDEA_PASSWORD=... [MIDEA_REGION=AUTO] [APPLIANCE_ID=...] npm run test:live
// A vezérlési teszt (be/ki) csak LIVE_CONTROL=1 esetén fut, és visszaállítja az eredeti állapotot.
import test from "node:test";
import assert from "node:assert/strict";
import { MideaCloud } from "../../worker/midea-cloud.js";
import { DeviceService } from "../../worker/device.js";

const { MIDEA_USER, MIDEA_PASSWORD, MIDEA_REGION = "AUTO", APPLIANCE_ID = "" } = process.env;
const skip = !MIDEA_USER || !MIDEA_PASSWORD ? "MIDEA_USER/MIDEA_PASSWORD hiányzik: éles teszt kihagyva" : false;

const svc = () => new DeviceService({ cloud: new MideaCloud({ account: MIDEA_USER, password: MIDEA_PASSWORD, region: MIDEA_REGION }), defaultApplianceId: APPLIANCE_ID });

test("ÉLES: bejelentkezés és eszközlista", { skip }, async () => {
  const r = await svc().listDevices();
  assert.ok(r.devices.length > 0);
  console.log(r.devices.map((d) => `${d.id} ${d.name} ${d.type} online=${d.online}`).join("\n"));
});

test("ÉLES: állapotlekérdezés (csak olvasás)", { skip }, async () => {
  const s = await svc().getStatus();
  console.log(JSON.stringify({ ...s, capabilities: undefined }));
  assert.ok(s.device.id);
});

test("ÉLES: be/ki kapcsolás és visszaállítás", { skip: skip || (process.env.LIVE_CONTROL === "1" ? false : "LIVE_CONTROL=1 nincs beállítva") }, async () => {
  const s = svc();
  const before = await s.getStatus();
  const flipped = await s.setPower(undefined, !before.power);
  assert.equal(flipped.power, !before.power);
  await s.setPower(undefined, before.power);
});
