'use strict';

const wrName = (setId) => { const p = setId.split('.'); return p[p.length - 2]; };
const isOffline = (o) => o === false || o === 'false' || o === 0 || o === '0';

/**
 * Regelkern: begrenzt die vom Zähler gemessene Netzeinspeisung je Gruppe, indem die Sollwerte der
 * Wechselrichter reduziert werden. Sobald kein Überschuss mehr vorhanden ist, gibt der Kern die
 * Sollwerte wieder frei (setzt sie auf maxW zurück), damit die Nulleinspeisung ohne Race Condition
 * erhöhen kann. Limit je nach Akkustand (Hysterese).
 *
 * io.get(id)            -> { val, ts } | undefined   (zwischengespeicherte Fremdzustände)
 * io.setSetpoint(id, v) -> Promise                   (schreibt mit ack=false)
 * io.publish(rel, v)    -> Promise                   (eigene Zustände)
 */
class NetzlimitCore {
    constructor({ cfg, io, log, now, enabled = true, limitActive = false }) {
        this.cfg = cfg;
        this.io = io;
        this.log = log;
        this.now = now || Date.now;
        this.enabled = enabled;
        this.limitActive = limitActive;
        this.topo = {};
        this.lastAdj = {};
        this.lastWarn = {};
        this.lastSoc = null;
        // Merkt, für welche Gruppen das Netzlimit gerade aktiv reduziert (true = wir haben Sollwerte
        // gesenkt und noch nicht freigegeben). Nur wenn dieser Flag gesetzt ist, darf regulate() auch
        // einen Freigabe-Schreibvorgang auslösen – so werden keine unnötigen Sollwert-Schreibvorgänge
        // erzeugt wenn der Adapter frisch startet und noch nie reduziert hat.
        this.capped = {};
        // Einschaltverzögerung: Zeitstempel, seit dem der Überschuss je Gruppe anhält.
        // Nur wenn excess > deadbandW für >= excessDelayS Sekunden gilt, wird reduziert.
        this.excessSince = {};
        // Seit wann der Rohüberschuss (ohne Ladereserve) je Gruppe anhält – begrenzt, wie lange die
        // freie Leistung der Ladegeräte angerechnet wird (chargerWaitS).
        this.rawExcessSince = {};
    }

    setTopology(found) { this.topo = found || {}; }

    meterId(g) { return g.meter ? `${this.cfg.meterBase}.${g.meter}.${this.cfg.meterPowerState}` : null; }
    onlineId(g) { return g.meter && this.cfg.meterOnlineState ? `${this.cfg.meterBase}.${g.meter}.${this.cfg.meterOnlineState}` : null; }
    selected(g) { return (this.topo[g.group] || []).filter((id) => !g.inverters.length || g.inverters.includes(wrName(id))); }
    actualId(setId) { return setId.slice(0, setId.lastIndexOf('.') + 1) + this.cfg.actualState; }
    limitOf(g) { return this.limitActive ? g.limitFull : g.limit; }
    toW(raw) { return Number(raw) * this.cfg.scale; }

    /** Aktive Ladegeräte einer Gruppe (leer, wenn die Funktion ausgeschaltet ist). */
    chargersOf(g) { return this.cfg.chargersEnabled ? (this.cfg.chargers || []).filter((c) => c.active && c.group === g.group) : []; }

    /** Ladeleistung eines Ladegeräts in W (≥ 0) oder null bei fehlendem/offline/veraltetem Wert. */
    chargerW(c) {
        const st = this.io.get(c.powerId);
        if (!st || st.val === null || st.val === undefined || st.val === '') return null;
        if (c.onlineId) {
            const on = this.io.get(c.onlineId);
            if (on && isOffline(on.val)) return null;
        }
        const v = Number(st.val);
        if (!Number.isFinite(v)) return null;
        if (this.cfg.chargerMaxAgeS > 0 && this.now() - st.ts > this.cfg.chargerMaxAgeS * 1000) return null;
        return Math.max(0, (c.invert ? -v : v) * c.scale);
    }

    /**
     * Ladeleistung und freie Ladereserve einer Gruppe. Reserve zählt nur bei Ladegeräten, die gerade
     * laden (≥ chargerMinW) – nur deren Regelung nimmt zusätzlichen Überschuss tatsächlich auf.
     */
    chargeOf(g) {
        let powerW = 0;
        let reserveW = 0;
        const list = [];
        for (const c of this.chargersOf(g)) {
            const w = this.chargerW(c);
            const charging = w !== null && w >= this.cfg.chargerMinW;
            if (w !== null) powerW += w;
            if (charging) reserveW += Math.max(0, c.maxW - w);
            list.push({ c, w, charging });
        }
        return { powerW, reserveW, list };
    }

    /** Alle Fremd-Datenpunkte, die beobachtet werden müssen. */
    watchedIds() {
        const ids = new Set([this.cfg.socId]);
        for (const g of this.cfg.groups) {
            const m = this.meterId(g);
            const o = this.onlineId(g);
            if (m) ids.add(m);
            if (o) ids.add(o);
            for (const id of this.selected(g)) { ids.add(id); ids.add(this.actualId(id)); }
            for (const c of this.chargersOf(g)) { ids.add(c.powerId); if (c.onlineId) ids.add(c.onlineId); }
        }
        return ids;
    }

    isMeterId(id) { return this.cfg.groups.some((g) => this.meterId(g) === id); }
    isChargerId(id) { return this.cfg.chargersEnabled && (this.cfg.chargers || []).some((c) => c.active && (c.powerId === id || c.onlineId === id)); }

    /** Zählerleistung in W (Bezug +, Einspeisung −) oder null bei fehlendem/offline/veraltetem Wert. */
    meterW(g) {
        const id = this.meterId(g);
        const st = id && this.io.get(id);
        if (!st) return null;
        const oid = this.onlineId(g);
        const on = oid && this.io.get(oid);
        if (on && isOffline(on.val)) return null;
        if (st.val === null || st.val === undefined || st.val === '') return null;
        const v = Number(st.val);
        if (!Number.isFinite(v)) return null;
        if (this.cfg.meterMaxAgeS > 0 && this.now() - st.ts > this.cfg.meterMaxAgeS * 1000) return null;
        return g.invert ? -v : v;
    }

    actualW(setId) {
        const st = this.io.get(this.actualId(setId));
        const v = st ? Number(st.val) : NaN;
        if (!st || st.val === null || st.val === undefined || !Number.isFinite(v)) {
            const s = this.io.get(setId);
            return s ? this.toW(s.val) : NaN;
        }
        return this.toW(v);
    }

    /** SoC-Hysterese: Voll-Limit ab socStart, normales Limit erst wieder unter socEnd. */
    evaluate() {
        const st = this.io.get(this.cfg.socId);
        const soc = st ? Number(st.val) : NaN;
        if (st && Number.isFinite(soc) && st.val !== null && st.val !== '') {
            this.lastSoc = soc;
            this.io.publish('SoC', soc);
            if (!this.limitActive && soc >= this.cfg.socStart) {
                this.limitActive = true;
                this.log.info(`SoC ${soc} % >= ${this.cfg.socStart} % -> Limit für vollen Akku gilt`);
            } else if (this.limitActive && soc < this.cfg.socEnd) {
                this.limitActive = false;
                this.log.info(`SoC ${soc} % < ${this.cfg.socEnd} % -> normales Limit gilt`);
            }
        } else {
            this.lastSoc = null;
        }
        this.refresh();
        this.regulate();
    }

    /** Veröffentlicht Messwerte, Limits und Status. */
    refresh() {
        const p = this.io.publish;
        p('Akku_Voll', this.limitActive);
        let okAll = this.lastSoc !== null;
        let active = 0;
        for (const g of this.cfg.groups) {
            const m = this.meterW(g);
            if (m !== null) p(`${g.group}.Einspeisung_W`, Math.round(Math.max(0, -m)));
            p(`${g.group}.Zaehler_OK`, m !== null);
            p(`${g.group}.Limit_W`, this.limitOf(g));
            p(`${g.group}.Status`, this.limitActive && g.active);
            if (g.active) { active++; if (m === null) okAll = false; }
            if (this.cfg.chargersEnabled) {
                const ch = this.chargeOf(g);
                p(`${g.group}.Ladeleistung_W`, Math.round(ch.powerW));
                p(`${g.group}.Ladereserve_W`, Math.round(ch.reserveW));
                for (const { c, w, charging } of ch.list) {
                    p(`Ladegeraete.${c.name}.Leistung_W`, w === null ? 0 : Math.round(w));
                    p(`Ladegeraete.${c.name}.OK`, w !== null);
                    p(`Ladegeraete.${c.name}.Laedt`, charging);
                }
            }
        }
        p('info.connection', okAll && active > 0);
    }

    onCharger() {
        this.refresh();
        this.regulate();
    }

    onMeter() {
        this.refresh();
        this.regulate();
    }

    /** Maximale konfigurierte Leistung (W) aller WR einer Gruppe, um Sollwerte freizugeben. */
    maxW(g) {
        // Wir verwenden das konfigurierte Limit als Freigabeziel – die Nulleinspeisung
        // überschreibt diesen Wert dann nach oben, sobald sie die Kontrolle zurückbekommt.
        // Da wir den echten WR-Max-Wert hier nicht kennen, setzen wir auf einen hohen Wert
        // (limit * 4 oder 800 W als Minimum), damit die Nulleinspeisung wieder Spielraum hat.
        return Math.max(800, this.limitOf(g) * 4);
    }

    regulate() {
        if (!this.enabled) return;
        const now = this.now();
        for (const g of this.cfg.groups) {
            if (!g.active) continue;
            const m = this.meterW(g);
            if (m === null) {
                if (now - (this.lastWarn[g.group] || 0) > 60000) {
                    this.log.warn(`${g.group}: Zähler „${g.meter || '(keiner)'}” nicht verfügbar, offline oder veraltet – keine Regelung`);
                    this.lastWarn[g.group] = now;
                }
                continue;
            }
            const limit = this.limitOf(g);
            const rawExcess = Math.max(0, -m) - limit;

            // Ladegeräte: freie Ladereserve wird vom Überschuss abgezogen, solange der Rohüberschuss
            // nicht länger als chargerWaitS anhält (0 = ohne Zeitgrenze). So drosselt das Netzlimit die
            // Wechselrichter nicht, während ein ladendes Gerät den Überschuss noch aufnehmen kann.
            let reserve = 0;
            if (rawExcess > this.cfg.deadbandW) {
                if (!this.rawExcessSince[g.group]) this.rawExcessSince[g.group] = now;
                const ch = this.chargeOf(g);
                if (ch.reserveW > 0) {
                    const heldS = (now - this.rawExcessSince[g.group]) / 1000;
                    if (this.cfg.chargerWaitS === 0 || heldS < this.cfg.chargerWaitS) reserve = ch.reserveW;
                    else if (now - (this.lastWarn[`ch:${g.group}`] || 0) > 60000) {
                        this.log.info(`${g.group}: Überschuss hält seit ${Math.round(heldS)} s an, Ladegeräte nehmen ihn nicht auf – Ladereserve (${Math.round(ch.reserveW)} W) wird ignoriert`);
                        this.lastWarn[`ch:${g.group}`] = now;
                    }
                }
            } else {
                this.rawExcessSince[g.group] = undefined;
            }
            const excess = rawExcess - reserve;
            if (reserve > 0 && rawExcess > this.cfg.deadbandW && excess <= this.cfg.deadbandW) {
                this.log.debug(`${g.group}: Überschuss ${Math.round(rawExcess)} W wird von Ladegeräten aufgenommen (Reserve ${Math.round(reserve)} W) – keine Drosselung`);
            }

            // Kein Überschuss mehr: Verzögerungszähler zurücksetzen und ggf. Sollwerte freigeben.
            if (excess <= this.cfg.deadbandW) {
                this.excessSince[g.group] = undefined;
                if (this.capped[g.group]) {
                    if (now - (this.lastAdj[g.group] || 0) >= this.cfg.intervalMs) {
                        this.capped[g.group] = false;
                        const freeW = this.maxW(g);
                        const freeRaw = Math.round((freeW / this.cfg.scale) * 1e6) / 1e6;
                        const items = this.selected(g)
                            .map((id) => { const s = this.io.get(id); return { id, set: s ? this.toW(s.val) : NaN }; })
                            .filter((x) => Number.isFinite(x.set) && x.set < freeW);
                        for (const x of items) {
                            if (this.cfg.dryRun) this.log.info(`[Testlauf] ${x.id}: würde Sollwert freigeben ${Math.round(x.set)} W -> ${freeW} W`);
                            else this.io.setSetpoint(x.id, freeRaw);
                        }
                        if (items.length) {
                            this.lastAdj[g.group] = now;
                            this.log.info(`${g.group}: Einspeisung ${Math.round(-m)} W ≤ Limit ${limit} W – Sollwerte freigegeben (${freeW} W)${this.cfg.dryRun ? ' (Testlauf)' : ''}`);
                        }
                    }
                }
                continue;
            }

            if (now - (this.lastAdj[g.group] || 0) < this.cfg.intervalMs) continue;

            // Einschaltverzögerung: Überschuss muss excessDelayS Sekunden ununterbrochen anhalten.
            if (this.cfg.excessDelayS > 0) {
                if (!this.excessSince[g.group]) {
                    this.excessSince[g.group] = now;
                    this.log.debug(`${g.group}: Überschuss ${Math.round(excess)} W erkannt, warte ${this.cfg.excessDelayS} s vor Eingriff`);
                    continue;
                }
                const waitedS = (now - this.excessSince[g.group]) / 1000;
                if (waitedS < this.cfg.excessDelayS) {
                    this.log.debug(`${g.group}: Überschuss ${Math.round(excess)} W seit ${Math.round(waitedS)} s (warte ${this.cfg.excessDelayS} s)`);
                    continue;
                }
            }

            // Nur Wechselrichter, die tatsächlich einspeisen, werden proportional zu ihrer Leistung reduziert
            const items = this.selected(g)
                .map((id) => { const s = this.io.get(id); return { id, set: s ? this.toW(s.val) : NaN, act: this.actualW(id) }; })
                .filter((x) => Number.isFinite(x.set) && x.act > 0);
            const sumAct = items.reduce((s, x) => s + x.act, 0);
            if (sumAct <= 0) continue;

            const reduce = Math.min(excess, sumAct);
            for (const x of items) {
                const target = Math.max(0, Math.round(x.act - (reduce * x.act) / sumAct));
                if (target < x.set) {
                    if (this.cfg.dryRun) this.log.info(`[Testlauf] ${x.id}: würde Sollwert ${Math.round(x.set)} W -> ${target} W setzen`);
                    else this.io.setSetpoint(x.id, Math.round((target / this.cfg.scale) * 1e6) / 1e6);
                }
            }
            this.capped[g.group] = true;
            this.lastAdj[g.group] = now;
            this.io.publish(`${g.group}.Letzte_Reduktion_W`, Math.round(reduce));
            this.log.info(`${g.group}: Einspeisung ${Math.round(-m)} W > Limit ${limit} W${this.limitActive ? ' (Akku voll)' : ''} ${reserve > 0 ? `, Ladereserve ${Math.round(reserve)} W` : ''} -> Reduktion um ${Math.round(reduce)} W${this.cfg.dryRun ? ' (Testlauf)' : ''}`);
        }
    }
}

module.exports = { NetzlimitCore, wrName };
