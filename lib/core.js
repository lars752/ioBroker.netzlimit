'use strict';

const wrName = (setId) => { const p = setId.split('.'); return p[p.length - 2]; };
const isOffline = (o) => o === false || o === 'false' || o === 0 || o === '0';

/**
 * Regelkern: begrenzt die vom Zähler gemessene Netzeinspeisung je Gruppe, indem die Sollwerte der
 * Wechselrichter reduziert werden (nie erhöht). Limit je nach Akkustand (Hysterese).
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
    }

    setTopology(found) { this.topo = found || {}; }

    meterId(g) { return g.meter ? `${this.cfg.meterBase}.${g.meter}.${this.cfg.meterPowerState}` : null; }
    onlineId(g) { return g.meter && this.cfg.meterOnlineState ? `${this.cfg.meterBase}.${g.meter}.${this.cfg.meterOnlineState}` : null; }
    selected(g) { return (this.topo[g.group] || []).filter((id) => !g.inverters.length || g.inverters.includes(wrName(id))); }
    actualId(setId) { return setId.slice(0, setId.lastIndexOf('.') + 1) + this.cfg.actualState; }
    limitOf(g) { return this.limitActive ? g.limitFull : g.limit; }
    toW(raw) { return Number(raw) * this.cfg.scale; }

    /** Alle Fremd-Datenpunkte, die beobachtet werden müssen. */
    watchedIds() {
        const ids = new Set([this.cfg.socId]);
        for (const g of this.cfg.groups) {
            const m = this.meterId(g);
            const o = this.onlineId(g);
            if (m) ids.add(m);
            if (o) ids.add(o);
            for (const id of this.selected(g)) { ids.add(id); ids.add(this.actualId(id)); }
        }
        return ids;
    }

    isMeterId(id) { return this.cfg.groups.some((g) => this.meterId(g) === id); }

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
        }
        p('info.connection', okAll && active > 0);
    }

    onMeter() {
        this.refresh();
        this.regulate();
    }

    regulate() {
        if (!this.enabled) return;
        const now = this.now();
        for (const g of this.cfg.groups) {
            if (!g.active) continue;
            const m = this.meterW(g);
            if (m === null) {
                if (now - (this.lastWarn[g.group] || 0) > 60000) {
                    this.log.warn(`${g.group}: Zähler „${g.meter || '(keiner)'}“ nicht verfügbar, offline oder veraltet – keine Regelung`);
                    this.lastWarn[g.group] = now;
                }
                continue;
            }
            const limit = this.limitOf(g);
            const excess = Math.max(0, -m) - limit;
            if (excess <= this.cfg.deadbandW) continue;
            if (now - (this.lastAdj[g.group] || 0) < this.cfg.intervalMs) continue;

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
            this.lastAdj[g.group] = now;
            this.io.publish(`${g.group}.Letzte_Reduktion_W`, Math.round(reduce));
            this.log.info(`${g.group}: Einspeisung ${Math.round(-m)} W > Limit ${limit} W${this.limitActive ? ' (Akku voll)' : ''} -> Reduktion um ${Math.round(reduce)} W${this.cfg.dryRun ? ' (Testlauf)' : ''}`);
        }
    }
}

module.exports = { NetzlimitCore, wrName };
