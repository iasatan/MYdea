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

test("frontend: nincs Midea végpont vagy Worker-side Midea secret", () => {
  for (const f of ["index.html", "app.js", "config.js", "service-worker.js", "manifest.json", "style.css"]) {
    if (!existsSync(new URL(f, root))) continue;
    const t = read(f);
    assert.ok(!/appsmb|smartmidea|midea\.com|meicloud/i.test(t), `${f}: Midea cím`);
    assert.ok(!/MIDEA_PASSWORD/.test(t), `${f}: jelszó`);
  }

  const app = read("app.js");
  const worker = read("worker/index.js");
  assert.match(app, /localStorage\.setItem\(LS\.mideaPassword/);
  assert.match(app, /["']x-midea-password["']/);
  assert.doesNotMatch(worker, /env\.MIDEA_/);
});

test("a service worker nem gyorsítótárazza az API hívásokat", () => {
  if (!existsSync(new URL("service-worker.js", root))) return;
  assert.match(read("service-worker.js"), /\/api\//);
});

test("GitHub Pages: a deployment megvárja az artifact feltöltését", () => {
  const workflow = read(".github/workflows/pages.yml");
  assert.match(workflow, /  build:\n[\s\S]*?uses: actions\/upload-pages-artifact@v3[\s\S]*?  deploy:\n/);
  assert.match(workflow, /  deploy:\n    needs: build\n[\s\S]*?uses: actions\/deploy-pages@v4/);
});
