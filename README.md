# ioBroker.netzlimit

Begrenzt die **gemessene Netzeinspeisung je Gruppe** und richtet das Limit nach dem Akkustand: normales Limit (Standard 800 W), bei vollem Akku ein strengeres (Standard 300 W).  
Dazu werden die Sollwerte der Wechselrichter einer Gruppe proportional zu ihrer aktuellen Leistung reduziert.

## Sicherheitsverhalten

- **Reduziert nur, erhöht nie:** Sollwerte werden ausschließlich gesenkt, und nur bei Wechselrichtern, die tatsächlich einspeisen.
- **Kein Zählerwert, keine Regelung:** Ist der Zähler nicht vorhanden, offline, ungültig oder älter als das eingestellte Maximalalter, wird die Gruppe nicht geregelt (Warnung im Log, höchstens einmal pro Minute).
- **Totband und Regeltakt** verhindern Schwingen (Standard 15 W und 3 s).
- **Hysterese beim SoC:** Voll-Limit ab SoC-Start (90 %), normales Limit erst wieder unter SoC-Ende (85 %). Der Zustand überlebt einen Neustart.
- **Neue Gruppen sind inaktiv** und müssen bewusst aktiviert werden.
- **Hauptschalter** `netzlimit.0.Aktiv` und **Testlauf** (protokolliert nur, schreibt nichts) für die Inbetriebnahme.
- Fehlerhafte Konfiguration: Der Adapter regelt nicht und meldet die Fehler im Log.

## Installation

1. ioBroker Admin → Adapter → Experten-Modus → „Adapter aus eigener URL installieren":  
   `https://github.com/lars752/ioBroker.netzlimit`  
   Alternativ: `iobroker url https://github.com/lars752/ioBroker.netzlimit`
2. Instanz anlegen und konfigurieren.

**Voraussetzungen:** Node.js ≥ 18, js-controller ≥ 5.0.19, Admin ≥ 6.12.2.

## Inbetriebnahme

1. In der Instanz Basis-Pfad, Datenpunkt-Namen, SoC-Datenpunkt und Zähler-Pfade konfigurieren.
2. Instanz einmal starten, dann auf **„Gruppen unter dem Basis-Pfad einlesen"** klicken. Gefundene Gruppen erscheinen in der Tabelle (zunächst inaktiv).
3. Pro Gruppe Zähler-Ordner, Limits und ggf. Wechselrichter eintragen, **Testlauf** einschalten, speichern und im Log prüfen, was der Adapter täte.
4. Testlauf ausschalten und die Gruppe auf **Aktiv** setzen.

## Konfiguration

| Einstellung | Standard | Bedeutung |
|---|---|---|
| Basis-Pfad | — | Struktur `<Basis>.<Gruppe>.WR<x>.<Sollwert>` |
| Sollwert-Datenpunkt | `Power` | Schreibbarer Datenpunkt je Wechselrichter |
| Istwert-Datenpunkt | `InvOutputWatts` | Lesbarer Datenpunkt je Wechselrichter |
| Skalierung | 1 | Faktor Datenpunktwert → Watt |
| SoC-Datenpunkt | — | Akkustand in % |
| SoC-Start | 90 % | Ab diesem SoC gilt das Voll-Limit |
| SoC-Ende | 85 % | Unter diesem SoC gilt wieder das normale Limit |
| Zähler-Basis | — | Pfad `<Basis>.<Zähler>.<Leistungs-Datenpunkt>` |
| Leistungs-Datenpunkt | `info.Total_Power` | Bezug +, Einspeisung − |
| Online-Datenpunkt | leer | optional, `false` stoppt die Regelung |
| Max. Alter Zählerwert | 120 s | 0 = nicht prüfen |
| Totband | 15 W | Mindestabweichung für eine Regelaktion |
| Regeltakt | 3000 ms | Mindestabstand zwischen Regelaktionen |
| Testlauf | aus | Nur protokollieren, nichts schreiben |

**Tabelle „Gruppen":** Gruppe (Ordnername unter dem Basis-Pfad), Aktiv, Limit, Limit Akku voll, Zähler (Ordnername unter der Zähler-Basis), Zähler invertieren, Wechselrichter (kommagetrennt, z. B. `WR1,WR2`; leer = alle gefundenen).

Änderungen an der Konfiguration starten die Instanz neu. Neue Wechselrichter einer Gruppe werden jede Minute erkannt.

## Datenpunkte (`netzlimit.0.*`)

| Datenpunkt | Inhalt |
|---|---|
| `Aktiv` | Hauptschalter (schreibbar) |
| `Akku_Voll` | Voll-Limit ist aktiv |
| `SoC` | gelesener Akkustand |
| `<gruppe>.Einspeisung_W` | gemessene Einspeisung der Gruppe |
| `<gruppe>.Limit_W` | aktuell gültiges Limit der Gruppe |
| `<gruppe>.Status` | Voll-Limit aktiv (und Gruppe aktiv) |
| `<gruppe>.Zaehler_OK` | Zählerwert gültig, online und aktuell |
| `<gruppe>.Letzte_Reduktion_W` | letzte Reduktion der Sollwerte |
| `info.connection` | SoC und alle aktiven Zähler gültig |

## Import / Export der Konfiguration

Im Reiter **„Import / Export"** der Instanz:

- **Export:** schreibt die aktuelle Konfiguration als JSON in das Textfeld.
- **Import:** JSON einfügen und „JSON aus dem Textfeld importieren" drücken. Die Werte erscheinen im Formular, danach „Speichern und schließen".

Ungültige Gruppenzeilen, fehlerhaftes JSON oder der Export einer anderen Adapterart werden abgelehnt. Fehlende Felder werden mit Standardwerten ergänzt.

```json
{
  "adapter": "netzlimit",
  "version": 1,
  "config": {
    "basis": "<Basis-Pfad>",
    "socId": "<SoC-Datenpunkt>",
    "socStart": 90,
    "socEnd": 85,
    "groups": [
      { "group": "<gruppe>", "active": true, "limit": 800, "limitFull": 300,
        "meter": "<zähler>", "invert": false, "inverters": "" }
    ]
  }
}
```

## Entwicklung

```bash
npm install
npm test     # läuft ohne ioBroker-Instanz
```

Struktur: `lib/model.js` (Konfiguration, Gruppensuche), `lib/core.js` (Regelkern), `lib/configio.js` (JSON-Import/-Export), `main.js` (Adapter).  
Der Workflow `.github/workflows/test.yml` führt die Tests bei jedem Push auf Node 18, 20 und 22 aus.

## Lizenz

MIT
