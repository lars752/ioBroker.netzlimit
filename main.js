'use strict';
const utils = require('@iobroker/adapter-core');
const { normalizeConfig, parseTopology, mergeDiscovered } = require('./lib/model');
const { NetzlimitCore } = require('./lib/core');
const configio = require('./lib/configio');

const RESCAN_MS = 60 * 1000;
const SAFETY_MS = 1000;
const KEEP = new Set(['info', 'info.connection', 'Aktiv', 'Akku_Voll', 'SoC']);

const GROUP_STATES = [
    ['Einspeisung_W', 'Aktuell gemessene Einspeisung', 'number', 'value.power', 'W', 0],
    ['Limit_W', 'Aktuell gültiges Einspeiselimit', 'number', 'value.power', 'W', 0],
    ['Status', 'Limit für vollen Akku momentan aktiv', 'boolean', 'indicator', '', false],
    ['Zaehler_OK', 'Zählerwert verfügbar, online und aktuell', 'boolean', 'indicator.reachable', '', false],
    ['Letzte_Reduktion_W', 'Letzte Reduktion der Wechselrichter-Sollwerte', 'number', 'value.power', 'W', 0],
];

const GROUP_CHARGE_STATES = [
    ['Ladeleistung_W', 'Ladeleistung der Ladegeräte', 'number', 'value.power', 'W', 0],
    ['Ladereserve_W', 'Freie Ladeleistung, die Überschuss aufnehmen kann', 'number', 'value.power', 'W', 0],
];

const CHARGER_STATES = [
    ['Leistung_W', 'Gelesene Ladeleistung', 'number', 'value.power', 'W', 0],
    ['OK', 'Wert verfügbar, online und aktuell', 'boolean', 'indicator.reachable', '', false],
    ['Laedt', 'Lädt gerade (über Mindest-Ladeleistung)', 'boolean', 'indicator', '', false],
];

class Netzlimit extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'netzlimit' });
        this.cache = new Map();   // eigene Zustände (zuletzt geschriebener Wert)
        this.fcache = new Map();  // Fremdzustände { val, ts }
        this.watched = new Set();
        this.queue = Promise.resolve();
        this.core = null;
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /** Schreibt geänderte Werte nacheinander in den Namensraum der Instanz (netzlimit.<N>). */
    write(id, val) {
        this.queue = this.queue
            .then(async () => {
                if (this.cache.get(id) === val) return;
                this.cache.set(id, val);
                await this.setStateAsync(id, { val, ack: true });
            })
            .catch((e) => this.log.error(`Schreiben von ${id} fehlgeschlagen: ${e.message}`));
        return this.queue;
    }

    async ensureStates(expected, prefix, label, list) {
        for (const [id, name, type, role, unit, def] of list) {
            const full = `${prefix}.${id}`;
            expected.add(full);
            const common = { name: `${label}: ${name}`, type, role, read: true, write: false, def };
            if (unit) common.unit = unit;
            await this.extendObjectAsync(full, { type: 'state', common, native: {} });
            if (!(await this.getStateAsync(full))) await this.setStateAsync(full, { val: def, ack: true });
        }
    }

    async ensureStructure(cfg) {
        const expected = new Set(KEEP);
        for (const g of cfg.groups) {
            expected.add(g.group);
            await this.extendObjectAsync(g.group, { type: 'channel', common: { name: `Gruppe ${g.group}` }, native: {} });
            await this.ensureStates(expected, g.group, g.group, cfg.chargersEnabled ? [...GROUP_STATES, ...GROUP_CHARGE_STATES] : GROUP_STATES);
        }
        const chargers = cfg.chargersEnabled ? cfg.chargers.filter((c) => c.active) : [];
        if (chargers.length) {
            expected.add('Ladegeraete');
            await this.extendObjectAsync('Ladegeraete', { type: 'folder', common: { name: 'Akku-Ladegeräte' }, native: {} });
            for (const c of chargers) {
                const ch = `Ladegeraete.${c.name}`;
                expected.add(ch);
                await this.extendObjectAsync(ch, { type: 'channel', common: { name: `Ladegerät ${c.name} (Gruppe ${c.group})` }, native: {} });
                await this.ensureStates(expected, ch, c.name, CHARGER_STATES);
            }
        }
        const all = await this.getAdapterObjectsAsync();
        for (const full of Object.keys(all)) {
            const rel = full.slice(this.namespace.length + 1);
            if (rel && !expected.has(rel) && !rel.startsWith('info.')) {
                await this.delObjectAsync(rel);
                this.log.info(`Veralteten Datenpunkt entfernt: ${rel}`);
            }
        }
    }

    async discover(basis, setpointState) {
        const objs = await this.getForeignObjectsAsync(`${basis}.*`, 'state');
        return parseTopology(Object.keys(objs || {}), basis, setpointState);
    }

    /** Abonniert die benötigten Fremd-Datenpunkte (Differenz zum bisherigen Stand) und füllt den Zwischenspeicher. */
    async syncWatched() {
        const want = this.core.watchedIds();
        for (const id of this.watched) {
            if (!want.has(id)) {
                this.unsubscribeForeignStates(id);
                this.fcache.delete(id);
                this.watched.delete(id);
            }
        }
        for (const id of want) {
            if (this.watched.has(id)) continue;
            this.watched.add(id);
            this.subscribeForeignStates(id);
            const st = await this.getForeignStateAsync(id);
            if (st) this.fcache.set(id, { val: st.val, ts: st.ts });
        }
    }

    async rescan() {
        const { cfg } = this;
        this.core.setTopology(await this.discover(cfg.basis, cfg.setpointState));
        await this.syncWatched();
    }

    async onReady() {
        await this.setStateAsync('info.connection', false, true);
        const { cfg, errors } = normalizeConfig(this.config, this.log);
        this.cfg = cfg;
        if (errors.length) {
            for (const e of errors) this.log.error(e);
            this.log.error('Konfiguration fehlerhaft – es wird nicht geregelt. Bitte in der Instanz korrigieren');
            return;
        }
        await this.ensureStructure(cfg);
        if (cfg.chargersEnabled) {
            const act = cfg.chargers.filter((c) => c.active);
            this.log.info(`Ladegeräte berücksichtigen: ${act.map((c) => `${c.name} → ${c.group} (max. ${c.maxW} W)`).join(', ') || '(keine aktiven Ladegeräte)'}`);
        }
        if (!cfg.groups.length) this.log.warn('Keine Gruppen konfiguriert – „Gruppen einlesen“ in der Instanz verwenden und Gruppen aktivieren');
        if (cfg.dryRun) this.log.warn('TESTLAUF aktiv: Es werden keine Sollwerte geschrieben');

        const aktiv = await this.getStateAsync('Aktiv');
        const voll = await this.getStateAsync('Akku_Voll');
        if (!aktiv || aktiv.val === null) await this.setStateAsync('Aktiv', { val: true, ack: true });
        this.core = new NetzlimitCore({
            cfg,
            log: this.log,
            enabled: !aktiv || aktiv.val !== false,
            limitActive: !!(voll && voll.val === true),
            io: {
                get: (id) => this.fcache.get(id),
                setSetpoint: (id, val) => {
                    this.fcache.set(id, { val, ts: Date.now() });
                    return this.setForeignStateAsync(id, { val, ack: false }).catch((e) => this.log.error(`Sollwert ${id}: ${e.message}`));
                },
                publish: (id, val) => this.write(id, val),
            },
        });
        this.subscribeStates('Aktiv');
        await this.rescan();
        this.core.evaluate();

        this.safetyTimer = setInterval(() => { try { this.core.regulate(); } catch (e) { this.log.error(e.message); } }, SAFETY_MS);
        this.rescanTimer = setInterval(() => this.rescan().catch((e) => this.log.error(`Gruppensuche: ${e.message}`)), RESCAN_MS);
        const found = Object.keys(this.core.topo);
        this.log.info(`Netzlimit gestartet, konfigurierte Gruppen: ${cfg.groups.map((g) => g.group).join(', ') || '(keine)'}; gefundene Wechselrichter-Gruppen: ${found.join(', ') || '(keine)'}`);
        for (const g of cfg.groups) if (!found.includes(g.group)) this.log.warn(`Gruppe ${g.group}: keine Wechselrichter unter ${cfg.basis}.${g.group}.WR*.${cfg.setpointState} gefunden`);
    }

    onStateChange(id, state) {
        if (!state) return;
        if (id === `${this.namespace}.Aktiv`) {
            if (state.ack === false && this.core) {
                this.core.enabled = state.val !== false && state.val !== 'false' && state.val !== 0;
                this.log.info(`Hauptschalter: ${this.core.enabled ? 'aktiv' : 'AUS'}`);
                this.setState('Aktiv', { val: this.core.enabled, ack: true });
            }
            return;
        }
        if (!this.core || !this.watched.has(id)) return;
        this.fcache.set(id, { val: state.val, ts: state.ts });
        try {
            if (id === this.cfg.socId) this.core.evaluate();
            else if (this.core.isMeterId(id)) this.core.onMeter();
            else if (this.core.isChargerId(id)) this.core.onCharger();
        } catch (e) {
            this.log.error(`Fehler bei ${id}: ${e.message}`);
        }
    }

    /** Nachrichten der Admin-Oberfläche: JSON-Export/-Import und Gruppensuche. */
    async onMessage(obj) {
        if (!obj || !obj.command || !obj.callback) return;
        let reply;
        try {
            const msg = obj.message || {};
            if (obj.command === 'exportConfig') reply = configio.exportConfig(msg.config);
            else if (obj.command === 'importConfig') reply = configio.importConfig(msg.json);
            else if (obj.command === 'discoverGroups') {
                const c = msg.config || {};
                const { cfg } = normalizeConfig(c);
                const found = await this.discover(cfg.basis, cfg.setpointState);
                const { rows, added } = mergeDiscovered(c.groups, found);
                reply = {
                    native: { groups: rows },
                    result: Object.keys(found).length
                        ? `${Object.keys(found).length} Gruppe(n) unter ${cfg.basis} gefunden, ${added.length} neu in die Tabelle übernommen${added.length ? ` (${added.join(', ')}; inaktiv)` : ''}. Danach „Speichern und schließen“ drücken.`
                        : `Unter ${cfg.basis} wurden keine Wechselrichter-Gruppen (…WR*.${cfg.setpointState}) gefunden.`,
                };
            } else return;
        } catch (e) {
            reply = { error: `Fehler: ${e.message}` };
        }
        this.sendTo(obj.from, obj.command, reply, obj.callback);
    }

    onUnload(callback) {
        try {
            if (this.safetyTimer) clearInterval(this.safetyTimer);
            if (this.rescanTimer) clearInterval(this.rescanTimer);
            this.setState('info.connection', false, true);
        } finally {
            callback();
        }
    }
}

if (require.main !== module) module.exports = (options) => new Netzlimit(options);
else new Netzlimit();
