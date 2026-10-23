# ioBroker.netzlimit

Begrenzt die **gemessene Netzeinspeisung je Gruppe** und richtet das Limit nach dem Akkustand: normales Limit (Standard 800 W), bei vollem Akku ein strengeres (Standard 300 W).
Dazu werden die Sollwerte der Wechselrichter einer Gruppe proportional zu ihrer aktuellen Leistung reduziert. Der Adapter ersetzt das Skript „Netzlimit mit SoC-abhängigem Limit“ (`0_userdata.0.Netzlimit`).

## Sicherheitsverhalten
- **Reduziert nur, erhöht nie:** Sollwerte werden ausschließlich gesenkt, und nur bei Wechselrichtern, die tatsächlich einspeisen.
- **Kein Zählerwert, keine Regelung:** Ist der Zähler nicht vorhanden, offline, ungültig oder älter als das eingestellte Maximalalter, wird die Gruppe nicht geregelt (Warnung im Log, höchstens einmal pro Minute).
- **Totband und Regeltakt** verhindern Schwingen (Standard 15 W und 3 s).
- **Hysterese beim SoC:** Voll-Limit ab SoC-Start (90 %), normales Limit erst wieder unter SoC-Ende (85 %). Der Zustand überlebt einen Neustart.
- **Neue Gruppen sind inaktiv** und müssen bewusst aktiviert werden.
- **Hauptschalter** `netzlimit.0.Aktiv` und **Testlauf** (protokolliert nur, schreibt nichts) für die Inbetriebnahme.
- Fehlerhafte Konfiguration: Der Adapter regelt nicht und meldet die Fehler im Log.

## Installation über GitHub
1. Auf GitHub ein **neues Repository `ioBroker.netzlimit`** anlegen (Benutzer `lars752`).
2. ZIP entpacken und den **Inhalt** des Ordners `ioBroker.netzlimit` (nicht den Ordner selbst) ins Hauptverzeichnis des Repositorys hochladen (Branch `main`). Danach müssen `package.json`, `io-package.json`, `main.js`, `lib/` und `admin/` direkt im Hauptverzeichnis sichtbar sein.
3. ioBroker Admin → Adapter → Experten-Modus → „Adapter aus eigener URL installieren“ → `https://github.com/lars752/ioBroker.netzlimit`
   oder `iobroker url https://github.com/lars752/ioBroker.netzlimit`
4. Instanz `netzlimit.0` anlegen und konfigurieren.

Voraussetzungen: Node.js ≥ 18, js-controller ≥ 5.0.19, Admin ≥ 6.12.2.

## Inbetriebnahme
1. **Altes Skript stoppen.** Skript und Adapter dürfen nicht gleichzeitig laufen, beide würden dieselben Sollwerte schreiben.
2. In der Instanz Basis-Pfad, Datenpunkt-Namen, SoC-Datenpunkt und Zähler-Pfade prüfen.
3. Instanz einmal starten, dann auf „Gruppen unter dem Basis-Pfad einlesen“ klicken. Gefundene Gruppen erscheinen in der Tabelle (inaktiv).
4. Pro Gruppe Zähler-Ordner, Limits und ggf. Wechselrichter eintragen, **Testlauf** einschalten, speichern und im Log prüfen, was der Adapter täte.
5. Testlauf ausschalten und die Gruppe auf „Aktiv“ setzen.

## Konfiguration
| Einstellung | Standard | Bedeutung |
|---|---|---|
| Basis-Pfad | `0_userdata.0.Wechselrichter` | Struktur `<Basis>.<Gruppe>.WR<x>.<Sollwert>` |
| Sollwert / Istwert | `Power` / `InvOutputWatts` | Datenpunkte je Wechselrichter |
| Skalierung | 1 | Faktor Datenpunktwert → Watt (Soll und Ist) |
| SoC-Datenpunkt | `growatt-bms.0.SoC` | Akkustand in % |
| SoC-Start / -Ende | 90 / 85 | Hysterese für das Voll-Limit |
| Zähler-Basis | `shelly-gruppen.0` | Pfad `<Basis>.<Zähler>.<Leistungs-Datenpunkt>` |
| Leistungs-Datenpunkt | `info.Total_Power` | Bezug +, Einspeisung − |
| Online-Datenpunkt | leer | optional, `false` stoppt die Regelung |
| Max. Alter Zählerwert | 120 s | 0 = nicht prüfen |
| Totband / Regeltakt | 15 W / 3000 ms | |
| Testlauf | aus | nur protokollieren |

Tabelle „Gruppen“: **Gruppe** (Ordnername unter dem Basis-Pfad), **Aktiv**, **Limit**, **Limit Akku voll**, **Zähler** (Ordnername unter der Zähler-Basis, z. B. `wohnung_links`), **Zähler invertieren**, **Wechselrichter** (kommagetrennt, z. B. `WR1,WR2`; leer = alle gefundenen).
Änderungen an der Konfiguration starten die Instanz neu. Neue Wechselrichter einer Gruppe werden jede Minute erkannt.

## Datenpunkte (`netzlimit.0.*`)
| Datenpunkt | Inhalt |
|---|---|
| `Aktiv` | Hauptschalter (schreibbar) |
| `Akku_Voll` | Limit für vollen Akku gilt |
| `SoC` | gelesener Akkustand |
| `<gruppe>.Einspeisung_W` | gemessene Einspeisung |
| `<gruppe>.Limit_W` | aktuell gültiges Limit |
| `<gruppe>.Status` | Limit für vollen Akku aktiv (und Gruppe aktiv) |
| `<gruppe>.Zaehler_OK` | Zählerwert gültig, online und aktuell |
| `<gruppe>.Letzte_Reduktion_W` | letzte Reduktion der Sollwerte |
| `info.connection` | SoC und alle aktiven Zähler gültig |

## Umstieg vom Skript
| Skript | Adapter |
|---|---|
| `Aktiv` (global) | Datenpunkt `netzlimit.0.Aktiv` |
| `Basis`, `SoC_ID`, `Sollwert_State`, `Istwert_State`, `Skalierung`, `SoC_Start`, `SoC_Ende` | gleichnamige Felder in der Instanz |
| `Zaehler_Basis`, `Zaehler_Leistung_State`, `Zaehler_Online_State` | Zähler-Basis, Leistungs-/Online-Datenpunkt |
| `Totband_W`, `Regeltakt_ms`, `Zaehler_MaxAlter_s` | Totband, Regeltakt, Max. Alter |
| `Gruppen.<g>.{Aktiv, Einspeise_Limit_W, Einspeise_Limit_Voll_W, Zaehler, Zaehler_Invertiert}` | Zeile der Gruppentabelle |
| `Gruppen.<g>.WR.<WRx>` (Schalter) | Spalte „Wechselrichter“ |
| `Gruppen.<g>.{Einspeisung_W, Status}` | `netzlimit.0.<gruppe>.…` |

Mit dem alten Zählerpfad: Zähler-Basis `0_userdata.0.Shelly`, Leistungs-Datenpunkt `Meter.TotalActivePower`, Online-Datenpunkt `Meter.online`.
Mit dem Adapter `shelly-gruppen`: Zähler-Basis `shelly-gruppen.0`, Leistungs-Datenpunkt `info.Total_Power` (Standard).
Danach `0_userdata.0.Netzlimit` löschen.

## Import / Export der Konfiguration (JSON)
Im Reiter „Import / Export“ der Instanz:
- **Export:** schreibt die aktuelle Konfiguration (auch ungespeicherte Änderungen) als JSON in das Textfeld; mit dem Kopier-Symbol sichern.
- **Import:** JSON einfügen und „JSON aus dem Textfeld importieren“ drücken. Die Werte erscheinen im Formular, danach „Speichern und schließen“ drücken.
- Ungültige Gruppenzeilen werden übersprungen und genannt. Ungültige globale Werte (z. B. SoC-Ende ≥ SoC-Start), defektes JSON oder ein Export einer anderen Adapterart werden abgelehnt.
- Die Instanz muss laufen, weil Export, Import und Gruppensuche über den Adapter abgewickelt werden.

Format (Auszug):
```json
{
  "adapter": "netzlimit",
  "version": 1,
  "config": {
    "basis": "0_userdata.0.Wechselrichter",
    "socId": "growatt-bms.0.SoC",
    "socStart": 90,
    "socEnd": 85,
    "groups": [
      { "group": "wohnung_links", "active": true, "limit": 800, "limitFull": 300,
        "meter": "wohnung_links", "invert": false, "inverters": "" }
    ]
  }
}
```
Fehlende Felder werden beim Import mit Standardwerten ergänzt.

## Entwicklung
```bash
npm install
npm test     # Regelung, SoC-Hysterese, Zählerprüfung, Konfiguration, Import/Export (ohne ioBroker lauffähig)
```
Struktur: `lib/model.js` (Konfiguration, Gruppensuche), `lib/core.js` (Regelkern), `lib/configio.js` (JSON-Import/-Export), `main.js` (Adapter). Der Workflow `.github/workflows/test.yml` führt die Tests bei jedem Push auf Node 18, 20 und 22 aus.

## Lizenz
MIT
