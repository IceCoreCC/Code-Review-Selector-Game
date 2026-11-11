# Review Rally – Projektkontext für Claude

Team-Tool, das spielerisch auswählt, wer einen Pull Request reviewt. Statt direkter Zuweisung
gibt es einen 3D-**Waldlauf**: Jedes Teammitglied ist ein Tier, der Sieger reviewt. Dazu kommen XP,
Level, freischaltbare Hüte und eine Bestenliste. Sprache der Oberfläche und der Kommentare: **Deutsch**.

## Dateien

| Datei | Inhalt |
|---|---|
| `index.html` | Die komplette App (HTML + CSS + JS in einer Datei), inkl. 3D-Welt mit three.js |
| `server.js` | Kleiner Node-Server **ohne npm-Abhängigkeiten**: liefert `index.html` aus + JSON-API, speichert in `data/state.json` |
| `Dockerfile`, `.dockerignore` | Image `node:22-alpine`, nur `server.js` + `index.html`, läuft als User `node` (UID 1000) |
| `.gitignore` | `data/` (Laufzeitdaten mit Namen/PRs/Login-Hashes) wird nie committet |

Es gibt bewusst **keinen Build-Schritt und keine Pakete**.

## Starten

```
node server.js          # → http://localhost:3000
```
Umgebungsvariablen: `PORT` (Standard 3000), `HOST` (Standard 0.0.0.0), `DATA_DIR` (Standard `./data`).
Ist `PORT` **nicht** gesetzt und 3000 belegt, probiert der Server 3001, 5000, 8888, 9090. Mit gesetztem
`PORT` gibt es bewusst keinen Ausweich-Port (wichtig im Cluster). Unter Windows ist 8080 oft durch
Hyper-V/WSL reserviert, daher 3000 als Standard.

## Zwei Modi von `index.html`

- **Server-Modus** (Seite über `http(s)://` vom Server geladen): gemeinsamer Stand fürs ganze Team.
- **Lokal-Modus** (Datei per Doppelklick, `file://`, oder Server nicht erreichbar): alles in `localStorage`
  (Schlüssel `duckderby.v1`, alter Name bewusst behalten), ohne Profile, alles frei editierbar.

## Server & Sync

- **REST + Polling, keine WebSockets** (bewusste Entscheidung: kein Echtzeitbedarf, weniger Gateway-Ärger).
- Browser schickt Änderungen ~120 ms nach einer Aktion als **feldweisen Patch** (`diffState` → `POST /api/patch`).
  Alle 3 s `GET /api/state?v=<version>` → `204`, wenn nichts neu ist. Fremde Änderungen werden
  „in place“ eingemischt (`mergeInPlace`), damit laufende Rennen ihre Objekt-Referenzen behalten.
- Gleiches Feld gleichzeitig geändert → letzte Änderung gewinnt (bei ~6 Leuten egal).
- **Speichern:** Jede Änderung schreibt sofort `data/state.json` (erst `.tmp`, dann umbenennen), beim Start
  wird sie geladen. **Keine Backups** – vom Nutzer so gewünscht. Ist die Datei unlesbar, startet der Server
  absichtlich nicht (überschreibt nie mit leerem Stand).
- **Nur eine Instanz** darf laufen (eine Datei, kein Locking).

API: `GET /` (Seite), `GET /healthz` („ok“), `GET /api/state`, `POST /api/patch`, `POST /api/join`
(neues Profil), `POST /api/claim` (freies Profil übernehmen), `POST /api/import` (nur solange Server leer).

## Profile / „Login“

- Beim ersten Besuch Pflicht-Dialog „Wer bist du?“ (nicht wegklickbar): Profil anlegen oder freies Profil beanspruchen.
- Browser speichert `{id, token}` in `localStorage` (`rr.me`), Server nur den SHA-256-Hash. Header `X-Member` / `X-Token`.
- **Nur die Person selbst** darf `name`, `pct` (Arbeitszeit), `animal`, `look` (Garderobe) ändern – prüft auch der Server.
  Für alle editierbar: Abwesend, Profil löschen, PRs, Rennen, XP.
- Kein Abmelden. „Login-Link kopieren“ im Profil-Dialog dient zum Anmelden in einem anderen Browser.
- **Kein echter Login.** Entra ID (über Gateway-Header oder Token-Prüfung) wurde besprochen und **bewusst
  vertagt**. Falls später gewünscht: Identität per konfigurierbarem Header lesen, Token-Modus als Fallback.

## Spielmechanik (Kurzfassung)

- **Ablauf:** Neue PRs kommen auf den **🍂 Laubhaufen** (Warteliste). Wer will, nimmt einen PR mit „🙋 Nehm ich“
  (Bonus +10 XP, +5 je 4 h Wartezeit, max. +30). Nach dem Daily: **Daily Derby** = ein Lauf pro verbliebenem PR,
  danach Zusammenfassung mit „Für Teams kopieren“. Dringendes: „🎲 Jetzt auslosen“.
- **Fairness:** Sieger wird **vorher** gewichtet ausgelost, das Rennen ist nur inszeniert (Hindernisse,
  Turbo, Zeitlupe ändern nichts am Ergebnis). Gewicht ~ Arbeitszeit, gesenkt durch Reviews der letzten 14 Tage
  (relativ zur Arbeitszeit) und offene Reviews. Abwesende und PR-Autor laufen nicht mit.
- **XP:** S 10 / M 20 / L 35 / XL 50, ⚡ +15 unter 4 h, +5 unter 24 h, 💛 Kudos +10. Nach 24 h: 🏴‍☠️ **Kopfgeld**
  (+10, +5 je 12 h, max. +50) – andere dürfen den PR „kapern“. Level = `floor(sqrt(xp/20)) + 1`, Seasons resetbar.
- **Joker:** Start 1, je 5 erledigte Reviews +1 (max. 3). Sieger kann sich damit freikaufen → Neustart ohne ihn.
- **Garderobe** (`UNLOCKS` in `index.html`): Tier, Hüte/Köpfe (Partyhut … Krone; Roboter-, Kürbiskopf und
  Ritterhelm *ersetzen* den Tierkopf), Spuren, Siegestänze, Looks (Gold, Chrom, Regenbogen).

## 3D (three.js r128 von cdnjs)

- Objekt `R3` in `index.html`: Waldlauf-Welt, Kamerafahrten, Partikel, Garderoben-Vorschau, Porträts für Listen.
- **Tiere** aus Low-Poly-Grundformen, je eine eigene Bau-Funktion: `QUADS` (Roter Panda, Waschbär, Nacktmull,
  Affe, Capybara – Beine mit Knie, Trab/Galopp), `BIRDS` (Adler, Falke – zweigliedrige Flügel), Fische (Lachs,
  Goldfisch im Glas auf Bollerwagen), Gummiente (Retro).
- **Hindernisse** pro Tierart (`OBST` + Dev-Humor `OBST_DEV`: Meeting, Kaffeepause, Merge-Konflikt, Bug, UFO),
  erscheinen erst kurz vor dem Tier. Übergreifende „Spektakel“ (Regen, Disco …) wurden **bewusst wieder entfernt**.
- **Externe Abhängigkeiten:** three.js von `cdnjs.cloudflare.com` und Schrift Fredoka von Google Fonts.
  Falls das Firmennetz CDNs blockiert: three.js vom Server ausliefern bzw. einbetten, Systemschrift nutzen.
  Ohne three.js läuft die Auslosung weiter, nur ohne 3D.

## Deployment (offen: hier weitermachen)

Ziel: **AKS**, ausgerollt über **ArgoCD** mit **Helm**, Routing per **Gateway API `HTTPRoute`** (nicht Ingress).
Nur intern erreichbar. Nutzer kennt sich mit dem Setup aus und hat interne Chart-Vorlagen – **an diesen orientieren**.

Anforderungen an das Chart:
- `replicas: 1`, `strategy: Recreate` (eine Datei, keine parallelen Schreiber)
- PVC `ReadWriteOnce` (z. B. 1 Gi) gemountet auf `/data` (`DATA_DIR=/data` ist im Image gesetzt)
- `securityContext.fsGroup: 1000` (sonst gehört das Volume root und `state.json` ist nicht schreibbar)
- `containerPort: 3000`, Liveness/Readiness `httpGet /healthz` Port 3000
- Ressourcen klein, z. B. requests `50m` / `64Mi`, limits `128Mi`
- Service + `HTTPRoute` auf Port 3000

Noch zu tun: Image bauen/pushen (Registry intern), Helm-Chart, ArgoCD-`Application`, `HTTPRoute`.

## Arbeitsweise mit dem Nutzer

- Direkt auf `master` committen und pushen ist ok, kein extra Branch nötig.
- Einfach halten: keine Abhängigkeiten, keine unnötigen Features; Daten bleiben im Projektordner.
- Änderungen an der 3D-Optik am besten mit gerenderten Screenshots (headless Chrome) prüfen.
