// Szerkezeti ellenőrzések: tiltott automatizmusok, titkok és Midea-címek a frontendben.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";

const root = new URL("../../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");

test("wrangler.toml: nincs Cron Trigger vagy ütemezés", () => {
  const t = read("wrangler.toml").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  assert.ok(!/crons?\s*=|\[triggers\]/i.test(t));
  assert.ok(!/scheduled\s*\(/.test(read("worker/index.js")));
});

test("wrangler.toml: nem tartalmaz titkot", () => {
  const t = read("wrangler.toml").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  assert.ok(!/MIDEA_PASSWORD|ACCESS_TOKEN|MIDEA_USER/.test(t));
});

test("frontend: nincs Midea cím és nincs jelszó", () => {
  for (const f of ["index.html", "app.js", "config.js", "service-worker.js", "manifest.json", "style.css"]) {
    if (!existsSync(new URL(f, root))) continue;
    const t = read(f);
    assert.ok(!/appsmb|smartmidea|midea\.com|meicloud/i.test(t), `${f}: Midea cím`);
    assert.ok(!/MIDEA_PASSWORD/.test(t), `${f}: jelszó`);
  }
});

test("a service worker nem gyorsítótárazza az API hívásokat", () => {
  if (!existsSync(new URL("service-worker.js", root))) return;
  assert.match(read("service-worker.js"), /\/api\//);
});
