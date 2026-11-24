# Midea Breezeless Cloud Remote

Mobilra optimalizált, magyar nyelvű PWA Midea Breezeless klíma távvezérlésére.
**Frontend:** GitHub Pages (HTML/CSS/vanilla JS). **Backend:** Cloudflare Worker (REST API), amely a Midea SmartHome Clouddal beszél. A frontend soha nem hív közvetlenül Midea szervert. Nincs szerver, adatbázis, cron, időzítés vagy automatizmus: minden műveletet a felhasználó indít.

## ⚠️ Fontos: mi bizonyított és mi nem

Ezt a projektet **nem lehetett valódi Midea fiókkal kipróbálni** a fejlesztés során. Állapot:

| Terület | Státus |
|---|---|
| Kriptográfia (aláírás, jelszó-hash, AES), AC keretek (lekérdezés, vezérlés, állapot/képesség értelmezés) | Bájtra egyezik a Python referenciával (`coolth-ac-controller`, `midea-local`); `test/offline/parity.test.js` |
| SmartHome bejelentkezés, útvonalválasztás, eszközlista | A `midea-local` forráskódja alapján portolva; **élesben nem kipróbálva** |
| Parancsküldés (`/v1/appliance/transparent/send`) | **Az elsődleges referencia (`coolth-ac-controller`) nem SmartHome-ot használ a vezérléshez** (Cooper & Hunter, appId 1121 – más API), a `midea-local` pedig csak bejelentkezést/listázást tartalmaz. A küldési végpont és formátum a harmadik féltől származó `bootstrap314/ac-man` projektből származik; a `mlafx/Klimacontrol` részleteiben eltér (5A5A burkoló, `funId`). **Nem bizonyított, hogy a te fiókodon működik.** |
| API / UI tesztek | Szimulált (mock) Midea Clouddal futnak: a Worker logikáját igazolják, **nem** a valódi kapcsolatot |
| Éles teszt | `test/live/live.test.js` – csak valódi hitelesítő adatokkal fut, itt nem futott |

További ismert hiányok:
- **Lamella-szög** (fokonkénti állítás) nincs megvalósítva; csak a lengetési mód jelenik meg.
- **MIDEA_REGION:** a SmartHome nem kínál felhasználó által választható régiót, az útvonalválasztás fiókalapú. `AUTO` (alapérték) esetén a Worker a `midea-local` módszerével keres szervert. Megadható `https://…appsmb.com/…` vagy `…smartmidea.net` gateway URL is; más gazda elutasításra kerül.
- **Egy munkamenet/fiók:** a Worker bejelentkezése kiléphetheti a telefonos Midea appot. Ajánlott a klímát egy **második Midea fiókkal megosztani**, és annak adatait használni a Workerben.
- Ha az első éles próbán a küldés hibát ad, a pontos hibakód a válaszban (`cloudCode`) látható – kérlek ezt vizsgáld a `worker/midea-cloud.js` `SEND` ágában.

## Szerkezet

```
index.html, style.css, app.js, config.js   frontend (GitHub Pages)
manifest.json, service-worker.js, assets/  PWA
worker/index.js         API, CORS, token- és eredet-ellenőrzés, validálás
worker/midea-cloud.js   SmartHome Cloud kliens (végpont-engedélylista)
worker/authentication.js  aláírás, jelszó-hash, AES
worker/device.js        eszközválasztás, állapot, vezérlés
worker/commands.js      AC keretek (CRC, checksum)
wrangler.toml           Worker konfiguráció (nincs cron)
test/                   offline (mock) és éles tesztek
```

## 1. GitHub repository létrehozása

```bash
gh auth login
gh repo create midea-cloud-remote --public --source=. --remote=origin --push
```
(Vagy hozd létre a webes felületen, majd `git remote add origin … && git push -u origin main`.) A repóba **soha** ne kerüljön jelszó vagy token.

## 2. GitHub Pages engedélyezése

```bash
gh api -X POST repos/FELHASZNALO/midea-cloud-remote/pages -f "source[branch]=main" -f "source[path]=/"
```
Vagy: Settings → Pages → Branch: `main` / `/ (root)`. Az oldal: `https://FELHASZNALO.github.io/midea-cloud-remote/`. A CORS-hoz szükséges **origin** (útvonal nélkül): `https://FELHASZNALO.github.io`.

## 3. Cloudflare Worker létrehozása

```bash
npm install
npx wrangler login
```
Nyisd meg a `wrangler.toml`-t, és írd át: `ALLOWED_ORIGIN = "https://FELHASZNALO.github.io"` (a saját felhasználóneveddel).

## 4. Midea SmartHome fiók

1. Telepítsd a **Midea SmartHome** appot, és hozz létre (vagy használd a meglévő) fiókot; a klíma legyen hozzáadva.
2. Ajánlott: oszd meg a klímát egy második fiókkal, és a Worker azt használja (lásd fent).
3. A fiók legyen SmartHome (nem NetHome Plus) fiók.

## 5. Worker Secrets

```bash
openssl rand -hex 32                      # ezt add meg ACCESS_TOKEN-ként
npx wrangler secret put ACCESS_TOKEN
```
A Midea e-mail-címet, jelszót és régiót **ne add meg Cloudflare secretként**. Ezeket a PWA Beállítások ablakában kell eltárolni; a böngésző `localStorage` tárhelyén maradnak, és minden API-kéréskor HTTPS fejlécként kerülnek továbbításra a Workernek. Helyi fejlesztéshez csak a Workerhez szükséges `.dev.vars` fájl használható (a `.gitignore` kizárja).

## 6. Eszközazonosító lekérése és 7. Worker telepítése

```bash
npx wrangler deploy
curl -s https://midea-cloud-remote.FELHASZNALO.workers.dev/api/devices \
  -H "Origin: https://FELHASZNALO.github.io" \
  -H "Authorization: Bearer AZ_ACCESS_TOKEN" \
  -H "X-Midea-User: MIDEA_EMAIL" \
  -H "X-Midea-Password: MIDEA_JELSZO" \
  -H "X-Midea-Region: AUTO"
```
A válasz az eszközök nevét és azonosítóját adja. Ha több klímád van, mentsd el az azonosítót titokként (biztonságos tárolás):

```bash
npx wrangler secret put APPLIANCE_ID
```
Egy klíma esetén automatikusan azt használja. A frontend Beállítások ablakában is választható eszköz (`X-Appliance-Id`).

## 8. Frontend konfigurálása

Írd át a `config.js`-ben az `apiBase` értékét a Worker URL-jére, majd:
```bash
git add -A && git commit -m "Konfiguráció" && git push
```
Első megnyitáskor a ⚙ Beállításokban add meg a Worker URL-t, az `ACCESS_TOKEN`-t, valamint a Midea e-mail-címet, jelszót és régiót. Ezek az adatok csak a készülék `localStorage` tárhelyébe kerülnek.

## 9. API-tesztelés

```bash
B=https://midea-cloud-remote.FELHASZNALO.workers.dev; O="Origin: https://FELHASZNALO.github.io"; A="Authorization: Bearer AZ_ACCESS_TOKEN"; U="X-Midea-User: MIDEA_EMAIL"; P="X-Midea-Password: MIDEA_JELSZO"; R="X-Midea-Region: AUTO"; J="Content-Type: application/json"
curl -s $B/api/status -H "$O" -H "$A" -H "$U" -H "$P" -H "$R"
curl -s -X POST $B/api/power -H "$O" -H "$A" -H "$U" -H "$P" -H "$R" -H "$J" -d '{"on":true}'
curl -s -X POST $B/api/mode -H "$O" -H "$A" -H "$U" -H "$P" -H "$R" -H "$J" -d '{"mode":"COOL"}'      # AUTO|COOL|HEAT|DRY|FAN
curl -s -X POST $B/api/temperature -H "$O" -H "$A" -H "$U" -H "$P" -H "$R" -H "$J" -d '{"temperature":24}'
curl -s -X POST $B/api/fan -H "$O" -H "$A" -H "$U" -H "$P" -H "$R" -H "$J" -d '{"speed":"low"}'       # vagy {"level":40}
```
Válasz: `{"ok":true,"data":…}` vagy `{"ok":false,"error":{"code","message"}}`.

Tesztek:
```bash
npm test                                   # offline (mock) tesztek
MIDEA_USER=… MIDEA_PASSWORD=… npm run test:live                  # éles, csak olvasás
LIVE_CONTROL=1 MIDEA_USER=… MIDEA_PASSWORD=… npm run test:live   # + be/ki kapcsolás, visszaállítással
```

## 10. Telepítés mobiltelefonra

- **Android (Chrome):** menü → „Alkalmazás telepítése”.
- **iPhone (Safari):** Megosztás → „Főképernyőhöz adás”.

Offline módban csak a felület töltődik be; a vezérléshez internet kell.

## Biztonság röviden

A Midea fiók e-mail-címe, jelszava és régiója kizárólag a készülék `localStorage` tárhelyében van eltárolva; a Worker kérésenként kapja meg, nem tartja őket Cloudflare secretként. Az `ACCESS_TOKEN` Cloudflare Secretként is és a készüléken is szükséges; a Bearer token időzítés-biztos összehasonlítással ellenőrzött. Csak a konfigurált Pages origin engedélyezett (POST-hoz kötelező), az API szigorúan ellenőrzi a bemenetet, és a Worker csak 6 rögzített Midea végpontot és `*.appsmb.com` / `*.smartmidea.net` gazdát hívhat. Jelszó vagy token nem kerül naplóba vagy API-válaszba.