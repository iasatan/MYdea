// Klíma távirányító: minden gomb valódi Worker API-hívást végez. Nincs automatikus lekérdezés (polling) vagy időzítés.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const LS = {
    token: "klima.token", base: "klima.base", device: "klima.device", theme: "klima.theme",
    mideaUser: "klima.mideaUser", mideaPassword: "klima.mideaPassword", mideaRegion: "klima.mideaRegion",
  };
  const MODE_HU = { AUTO: "Automata", COOL: "Hűtés", HEAT: "Fűtés", DRY: "Párátlanítás", FAN: "Ventilátor" };
  const FAN_HU = { auto: "Automata", silent: "Csendes", low: "Alacsony", medium: "Közepes", high: "Magas", max: "Maximum" };
  const SWING_HU = { off: "Ki", vertical: "Függőleges", horizontal: "Vízszintes", both: "Mindkettő", unknown: "Ismeretlen" };

  let state = null;
  let busy = 0;
  let tempTimer = null;
  let pendingTemp = null;

  const get = (k) => localStorage.getItem(k) || "";
  const apiBase = () => (get(LS.base) || (window.MIDEA_CONFIG && window.MIDEA_CONFIG.apiBase) || "").replace(/\/+$/, "");

  function showError(msg) {
    const el = $("error-banner");
    el.textContent = msg;
    el.hidden = !msg;
  }

  function setBusy(delta) {
    busy += delta;
    $("loader").hidden = busy <= 0;
  }

  async function api(path, { method = "GET", body } = {}) {
    if (!navigator.onLine) throw new Error("Nincs internetkapcsolat.");
    const base = apiBase();
    const token = get(LS.token);
    const mideaUser = get(LS.mideaUser);
    const mideaPassword = get(LS.mideaPassword);
    if (!base || base.includes("FELHASZNALO")) throw new Error("Állítsd be a Worker URL-t a ⚙ Beállításokban.");
    if (!token) throw new Error("Add meg a hozzáférési tokent a ⚙ Beállításokban.");
    if (!mideaUser || !mideaPassword) throw new Error("Add meg a Midea e-mail-címet és jelszót a ⚙ Beállításokban.");
    const headers = {
      authorization: `Bearer ${token}`,
      "x-midea-user": mideaUser,
      "x-midea-password": mideaPassword,
      "x-midea-region": get(LS.mideaRegion) || "AUTO",
    };
    const dev = get(LS.device);
    if (dev) headers["x-appliance-id"] = dev;
    if (body !== undefined) headers["content-type"] = "application/json";
    let res;
    try {
      res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
    } catch {
      throw new Error("A Worker nem érhető el (hálózati vagy CORS hiba).");
    }
    let json = null;
    try { json = await res.json(); } catch { /* nem JSON */ }
    if (!json) throw new Error(`Váratlan válasz a szervertől (HTTP ${res.status}).`);
    if (!json.ok) throw new Error(json.error && json.error.message ? json.error.message : "Ismeretlen hiba.");
    return json.data;
  }

  async function run(fn) {
    setBusy(1);
    try {
      showError("");
      await fn();
    } catch (e) {
      showError(e.message);
    } finally {
      setBusy(-1);
    }
  }

  const fmtT = (v) => (typeof v === "number" ? v.toFixed(Number.isInteger(v) ? 0 : 1).replace(".", ",") : "–");

  function rangeNow() {
    const c = state.capabilities.temperature;
    return c.byMode[state.mode] || { min: c.min, max: c.max };
  }

  function render() {
    const s = state;
    const online = s && s.device && s.device.online;
    $("device-name").textContent = (s && s.device && s.device.name) || "Klíma";
    $("conn-dot").className = `dot ${s ? (online ? "online" : "offline") : ""}`;
    $("conn-text").textContent = !s ? "Ismeretlen" : online ? "Online" : "Offline";

    const usable = Boolean(s && online && !s.offline);
    $("power-btn").disabled = !usable;
    $("power-btn").setAttribute("aria-pressed", String(usable && s.power));
    $("power-text").textContent = usable && s.power ? "Be – kikapcsolás" : "Ki – bekapcsolás";

    $("indoor").textContent = usable ? `${fmtT(s.indoorTemperature)}°` : "–";
    const shown = pendingTemp ?? (usable ? s.targetTemperature : null);
    $("target-view").textContent = shown === null ? "–" : `${fmtT(shown)}°`;
    $("target").textContent = shown === null ? "–" : fmtT(shown);

    const modes = $("modes");
    const fans = $("fans");
    modes.replaceChildren();
    fans.replaceChildren();
    $("fan-custom").hidden = true;
    $("temp-minus").disabled = $("temp-plus").disabled = true;
    $("range-hint").textContent = "";
    $("swing").textContent = usable ? SWING_HU[s.swing] || s.swing : "–";
    if (!usable) return;

    const cap = s.capabilities;
    for (const m of cap.modes) {
      modes.append(chip(MODE_HU[m] || m, s.mode === m, () => command("/api/mode", { mode: m })));
    }
    for (const f of cap.fanSpeeds) {
      fans.append(chip(FAN_HU[f] || f, s.fan.speed === f, () => command("/api/fan", { speed: f })));
    }
    if (cap.customFan) {
      $("fan-custom").hidden = false;
      $("fan-slider").value = s.fan.raw >= 1 && s.fan.raw <= 100 ? s.fan.raw : 50;
      $("fan-level").textContent = $("fan-slider").value;
    }
    const r = rangeNow();
    const step = cap.temperature.step;
    const cur = pendingTemp ?? s.targetTemperature;
    $("temp-minus").disabled = cur - step < r.min - 1e-9;
    $("temp-plus").disabled = cur + step > r.max + 1e-9;
    $("range-hint").textContent = `Támogatott tartomány: ${fmtT(r.min)}–${fmtT(r.max)} °C`;
  }

  function chip(text, active, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(active));
    b.textContent = text;
    b.addEventListener("click", onClick);
    return b;
  }

  function accept(data) {
    state = data;
    pendingTemp = null;
    if (data.queriedAt) $("last-ok").textContent = new Date(data.queriedAt).toLocaleTimeString("hu-HU");
    render();
    if (data.confirmed === false) showError("A klíma még nem erősítette meg a változást. Frissíts néhány másodperc múlva.");
  }

  const refresh = () => run(async () => accept(await api("/api/status")));
  const command = (path, body) => run(async () => accept(await api(path, { method: "POST", body })));

  function stepTemp(dir) {
    if (!state) return;
    const step = state.capabilities.temperature.step;
    const r = rangeNow();
    const next = (pendingTemp ?? state.targetTemperature) + dir * step;
    if (next < r.min - 1e-9 || next > r.max + 1e-9) return;
    pendingTemp = Math.round(next * 2) / 2;
    render();
    clearTimeout(tempTimer);
    // Rövid várakozás a gyors egymás utáni koppintásokhoz; ez felhasználói műveletre épül, nem automatizmus.
    tempTimer = setTimeout(() => {
      const t = pendingTemp;
      command("/api/temperature", { temperature: t });
    }, 700);
  }

  // --- Téma ---
  function applyTheme(t) {
    if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    const dark = t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    $("theme-color").content = dark ? "#0f1115" : "#f3f5f9";
  }
  $("theme-btn").addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    localStorage.setItem(LS.theme, next);
    applyTheme(next);
  });
  applyTheme(get(LS.theme));

  // --- Beállítások ---
  const dlg = $("settings");
  $("settings-btn").addEventListener("click", () => {
    $("cfg-base").value = get(LS.base) || (window.MIDEA_CONFIG && window.MIDEA_CONFIG.apiBase) || "";
    $("cfg-token").value = get(LS.token);
    $("cfg-midea-user").value = get(LS.mideaUser);
    $("cfg-midea-password").value = get(LS.mideaPassword);
    $("cfg-midea-region").value = get(LS.mideaRegion) || "AUTO";
    $("cfg-devices-info").textContent = "";
    const sel = $("cfg-device");
    sel.replaceChildren(new Option("Automatikus", ""));
    if (get(LS.device)) sel.append(new Option(`Azonosító: ${get(LS.device)}`, get(LS.device)));
    sel.value = get(LS.device);
    dlg.showModal();
  });
  $("cfg-load-devices").addEventListener("click", async () => {
    localStorage.setItem(LS.base, $("cfg-base").value.trim());
    localStorage.setItem(LS.token, $("cfg-token").value.trim());
    localStorage.setItem(LS.mideaUser, $("cfg-midea-user").value.trim());
    localStorage.setItem(LS.mideaPassword, $("cfg-midea-password").value);
    localStorage.setItem(LS.mideaRegion, $("cfg-midea-region").value.trim() || "AUTO");
    const info = $("cfg-devices-info");
    info.textContent = "Betöltés…";
    try {
      const d = await api("/api/devices");
      const sel = $("cfg-device");
      sel.replaceChildren(new Option("Automatikus", ""));
      for (const x of d.devices) {
        if (x.supported) sel.append(new Option(`${x.name} (${x.id})${x.online ? "" : " – offline"}`, x.id));
      }
      sel.value = get(LS.device);
      info.textContent = d.devices.map((x) => `${x.name}: ${x.id} (${x.type})`).join(" • ");
    } catch (e) {
      info.textContent = e.message;
    }
  });
  $("settings-form").addEventListener("submit", (e) => {
    if (e.submitter && e.submitter.value === "save") {
      localStorage.setItem(LS.base, $("cfg-base").value.trim());
      localStorage.setItem(LS.token, $("cfg-token").value.trim());
      localStorage.setItem(LS.mideaUser, $("cfg-midea-user").value.trim());
      localStorage.setItem(LS.mideaPassword, $("cfg-midea-password").value);
      localStorage.setItem(LS.mideaRegion, $("cfg-midea-region").value.trim() || "AUTO");
      localStorage.setItem(LS.device, $("cfg-device").value);
      state = null;
      render();
      refresh();
    }
  });

  // --- Vezérlők ---
  $("power-btn").addEventListener("click", () => state && command("/api/power", { on: !state.power }));
  $("temp-minus").addEventListener("click", () => stepTemp(-1));
  $("temp-plus").addEventListener("click", () => stepTemp(1));
  $("refresh-btn").addEventListener("click", refresh);
  $("fan-slider").addEventListener("input", (e) => { $("fan-level").textContent = e.target.value; });
  $("fan-slider").addEventListener("change", (e) => command("/api/fan", { level: Number(e.target.value) }));

  // --- Kapcsolat és életciklus ---
  function netState() {
    $("offline-banner").hidden = navigator.onLine;
  }
  addEventListener("online", netState);
  addEventListener("offline", netState);
  netState();
  // Visszatéréskor egyszeri frissítés (nem időzített lekérdezés).
  document.addEventListener("visibilitychange", () => { if (!document.hidden && state) refresh(); });

  if ("serviceWorker" in navigator) {
    addEventListener("load", () => navigator.serviceWorker.register("service-worker.js").catch(() => {}));
  }

  render();
  if (get(LS.token) && get(LS.mideaUser) && get(LS.mideaPassword)) refresh();
  else showError("Első indítás: nyisd meg a ⚙ Beállításokat, és add meg a Worker, token és Midea fiók adatait.");
})();
