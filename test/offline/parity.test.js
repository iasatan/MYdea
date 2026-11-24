// Egyezőségi tesztek a Python referenciaimplementációból (coolth-ac-controller) generált vektorok ellen.
// Ezek NEM Midea Cloud kapcsolatot igazolnak, csak a protokoll-port pontosságát.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  aesCbcDecryptHex, aesCbcEncryptHex, encryptIamPassword, encryptPassword, md5Hex, sha256Hex, signRequest,
} from "../../worker/authentication.js";
import { buildCapabilitiesQuery, buildSetState, buildStateQuery, setNextMessageId } from "../../worker/commands.js";
import { parseCapabilities, parseResponse, parseState } from "../../worker/device.js";
import { toHex, fromHex } from "../../worker/authentication.js";

const g = JSON.parse(readFileSync(new URL("../fixtures/golden.json", import.meta.url)));
const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const camelKeys = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [camel(k), v]));

test("md5 ismert vektor", () => {
  assert.equal(md5Hex("abc"), "900150983cd24fb0d6963f7d28e17f72");
});

test("sha256, HMAC aláírás, AES-CBC egyezik a Pythonnal", async () => {
  const c = g.crypto;
  assert.equal(await encryptPassword(c.loginId, c.password), c.sha);
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(await signRequest(c.signBody, c.signRandom), c.sign);
  assert.equal(await aesCbcEncryptHex(c.aesPlain, c.aesKey, c.aesIv), c.aesCipherHex);
  assert.equal(await aesCbcDecryptHex(c.aesCipherHex, c.aesKey, c.aesIv), c.aesPlain);
});

test("jelszó-átalakítás (iampwd) egyezik a Pythonnal", async () => {
  assert.equal(await encryptIamPassword(g.crypto.loginId, g.crypto.password), g.crypto.iam);
});

test("lekérdező keretek bájtra egyeznek", () => {
  setNextMessageId(1);
  assert.equal(toHex(buildStateQuery()), g.query.state);
  assert.equal(toHex(buildCapabilitiesQuery(false)), g.query.capabilities);
  assert.equal(toHex(buildCapabilitiesQuery(true)), g.query.capabilitiesAdditional.length ? g.query.capabilitiesAdditional : "");
});

for (const c of g.set) {
  test(`parancskeret: ${c.name}`, () => {
    setNextMessageId(c.messageId);
    assert.equal(toHex(buildSetState(camelKeys(c.params))), c.frame);
  });
}

test("állapotválasz értelmezése egyezik a Pythonnal", () => {
  for (const s of g.state) {
    const r = parseResponse(fromHex(s.frame));
    assert.equal(r.kind, "state");
    for (const [k, v] of Object.entries(s.parsed)) {
      if (k in r.state || camel(k) in r.state) assert.equal(r.state[camel(k)], v, k);
    }
  }
});

test("képességválasz értelmezése egyezik a Pythonnal", () => {
  for (const c of g.capabilities) {
    const r = parseResponse(fromHex(c.frame));
    assert.equal(r.kind, "capabilities");
    for (const [k, v] of Object.entries(c.raw)) {
      if (k in r.raw) assert.equal(r.raw[k], v, k);
    }
  }
});
