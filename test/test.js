'use strict';
const assert = require('assert');
const { normalizeConfig, parseTopology, mergeDiscovered, DEFAULTS } = require('../lib/model');
const { NetzlimitCore } = require('../lib/core');
const { exportConfig, importConfig } = require('../lib/configio');

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };
const logs = { warn: [], info: [], error: [] };
const log = { debug() {}, info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m), error: (m) => logs.error.push(m) };
const silent = { debug() {}, info() {}, warn() {}, error() {} };

const BASE = 'wr.0.Wechselrichter';
const SET = (g, w) => `${BASE}.${g}.${w}.Power`;
const ACT = (g, w) => `${BASE}.${g}.${w}.InvOutputWatts`;
const METER = (g) => `sh.0.${g}.info.Total_Power`;

/** Baut Kern + simulierte Umgebung. */
function mk(over = {}, groupOver = {}) {
    const t = { now: 10_000_000 };
    const states = new Map();
    const writes = [];
    const pub = {};
    const put = (id, val, ts) => states.set(id, { val, ts: ts === undefined ? t.now : ts });
    const { cfg, errors } = normalizeConfig({
        basis: BASE, meterBase: 'sh.0', socId: 'bms.0.SoC', meterMaxAgeS: 0,
        groups: [{ group: 'g1', active: true, limit: 800, limitFull: 300, meter: 'g1', ...groupOver }],
        ...over,
    }, silent);
    assert.deepStrictEqual(errors, []);
    const core = new NetzlimitCore({
        cfg, log, now: () => t.now,
        io: {
            get: (id) => states.get(id),
            setSetpoint: (id, v) => { writes.push([id, v]); return Promise.resolve(); },
            publish: (id, v) => { pub[id] = v; return Promise.resolve(); },
        },
    });
    core.setTopology({ g1: [SET('g1', 'WR1'), SET('g1', 'WR2')] });
    put('bms.0.SoC', 50);
    put(METER('g1'), -1000);
    put(SET('g1', 'WR1'), 800); put(ACT('g1', 'WR1'), 600);
    put(SET('g1', 'WR2'), 600); put(ACT('g1', 'WR2'), 400);
    return { t, core, writes, pub, put, cfg };
}

(async () => {
    await test('Konfiguration: Standardwerte sind gültig', () => {
        const r = normalizeConfig({}, silent);
        assert.deepStrictEqual(r.errors, []);
        assert.strictEqual(r.cfg.socStart, 90);
        assert.strictEqual(r.cfg.groups.length, 0);
        assert.strictEqual(r.cfg.dryRun, false);
    });
    await test('Konfiguration: Fehler in globalen Werten', () => {
        const r = normalizeConfig({ socStart: 80, socEnd: 85, scale: 0, basis: 'a b', intervalMs: 10, deadbandW: -1, meterMaxAgeS: 'x' }, silent);
        assert.strictEqual(r.errors.length, 6);
    });
    await test('Konfiguration: Gruppenzeilen prüfen', () => {
        logs.warn.length = 0;
        const r = normalizeConfig({ groups: [
            { group: 'a', active: true, limit: 500, limitFull: 100, meter: 'm', inverters: 'WR1, WR2' },
            { group: 'a' },                              // doppelt
            { group: 'b c' },                            // Leerzeichen
            { group: 'd', limit: -5 },                   // Limit
            { group: 'e', inverters: 'X1' },             // kein WR-Name
            { group: 'f', meter: 'a.b' },                // Punkt im Zähler
            { group: '', meter: '', inverters: '' },     // leer, still ignoriert
            { group: 'h', limit: '', limitFull: '' },    // Standard-Limits
        ], }, log);
        assert.deepStrictEqual(r.cfg.groups.map((g) => g.group), ['a', 'h']);
        assert.deepStrictEqual(r.cfg.groups[0].inverters, ['WR1', 'WR2']);
        assert.strictEqual(r.cfg.groups[1].limit, 800);
        assert.strictEqual(logs.warn.length, 5);
    });
    await test('Topologie: Gruppen und Wechselrichter finden', () => {
        const ids = [`${BASE}.g1.WR1.Power`, `${BASE}.g1.WR2.Power`, `${BASE}.g1.WR1.InvOutputWatts`, `${BASE}.g2.WRx.Power`, `${BASE}.g2.Total_Power`, 'andere.g3.WR1.Power'];
        assert.deepStrictEqual(parseTopology(ids, BASE, 'Power'), { g1: [`${BASE}.g1.WR1.Power`, `${BASE}.g1.WR2.Power`], g2: [`${BASE}.g2.WRx.Power`] });
    });
    await test('Gruppensuche: nur neue Gruppen, inaktiv, Zähler-Vorbelegung', () => {
        const r = mergeDiscovered([{ group: 'g1', active: true }], { g1: [], wohnung_links: [], garten: [] });
        assert.deepStrictEqual(r.added, ['garten', 'wohnung_links']);
        const wl = r.rows.find((x) => x.group === 'wohnung_links');
        assert.strictEqual(wl.active, false);
        assert.strictEqual(wl.meter, 'wohnung_links');
        assert.strictEqual(r.rows.find((x) => x.group === 'garten').meter, '');
        assert.strictEqual(r.rows[0].active, true);
    });
    await test('Regelung: proportionale Reduktion nur über dem Limit', () => {
        const { core, writes, pub } = mk();
        core.regulate();
        assert.deepStrictEqual(writes, [[SET('g1', 'WR1'), 480], [SET('g1', 'WR2'), 320]]);
        assert.strictEqual(pub['g1.Letzte_Reduktion_W'], 200);
    });
    await test('Regelung: Totband und Mindestabstand', () => {
        const a = mk(); a.put(METER('g1'), -810); a.core.regulate();
        assert.strictEqual(a.writes.length, 0);
        const b = mk(); b.core.regulate(); b.core.regulate();
        assert.strictEqual(b.writes.length, 2);
        b.t.now += 3001; b.core.regulate();
        assert.strictEqual(b.writes.length, 4);
    });
    await test('Regelung: nur einspeisende Wechselrichter, nie erhöhen', () => {
        const a = mk(); a.put(ACT('g1', 'WR2'), 0); a.core.regulate();
        assert.deepStrictEqual(a.writes, [[SET('g1', 'WR1'), 400]]);
        const b = mk(); b.put(SET('g1', 'WR1'), 300); b.put(SET('g1', 'WR2'), 300); b.core.regulate();
        assert.strictEqual(b.writes.length, 0); // Ziel liegt über dem aktuellen Sollwert
    });
    await test('Regelung: Reduktion ist durch die Ist-Leistung begrenzt', () => {
        const { core, writes, put } = mk(); put(METER('g1'), -5000); core.regulate();
        assert.deepStrictEqual(writes.map((w) => w[1]), [0, 0]);
    });
    await test('Regelung: Skalierung (Sollwert in Zehntel-Watt)', () => {
        const { core, writes, put } = mk({ scale: 0.1 });
        put(SET('g1', 'WR1'), 8000); put(ACT('g1', 'WR1'), 6000); put(SET('g1', 'WR2'), 6000); put(ACT('g1', 'WR2'), 4000);
        core.regulate();
        assert.deepStrictEqual(writes, [[SET('g1', 'WR1'), 4800], [SET('g1', 'WR2'), 3200]]);
    });
    await test('Regelung: Istwert fehlt -> Sollwert als Ersatz', () => {
        const { core, writes, put, t } = mk();
        put(ACT('g1', 'WR1'), null); put(ACT('g1', 'WR2'), null);
        core.regulate();
        assert.ok(writes.length === 2 && writes[0][1] < 800);
        void t;
    });
    await test('Regelung: Zähler invertiert', () => {
        const { core, writes, put } = mk({}, { invert: true });
        put(METER('g1'), 1000); core.regulate();
        assert.strictEqual(writes.length, 2);
    });
    await test('Regelung: Zähler offline, veraltet oder ungültig -> keine Regelung', () => {
        logs.warn.length = 0;
        const a = mk({ meterOnlineState: 'online' }); a.core.setTopology({ g1: [SET('g1', 'WR1')] });
        a.put('sh.0.g1.online', false); a.core.regulate();
        assert.strictEqual(a.writes.length, 0);
        assert.strictEqual(logs.warn.length, 1);
        const b = mk({ meterMaxAgeS: 30 }); b.put(METER('g1'), -1000, b.t.now - 31_000); b.core.regulate();
        assert.strictEqual(b.writes.length, 0);
        const c = mk(); c.put(METER('g1'), 'abc'); c.core.regulate();
        assert.strictEqual(c.writes.length, 0);
        const d = mk({ meterOnlineState: 'online' }); d.put('sh.0.g1.online', true); d.core.regulate();
        assert.strictEqual(d.writes.length, 2);
    });
    await test('Regelung: Hauptschalter, inaktive Gruppe, Testlauf', () => {
        const a = mk(); a.core.enabled = false; a.core.regulate();
        assert.strictEqual(a.writes.length, 0);
        const b = mk({}, { active: false }); b.core.regulate();
        assert.strictEqual(b.writes.length, 0);
        const c = mk({ dryRun: true }); c.core.regulate();
        assert.strictEqual(c.writes.length, 0);
        assert.ok(c.core.lastAdj.g1 > 0);
    });
    await test('Regelung: Auswahl der Wechselrichter', () => {
        const { core, writes } = mk({}, { inverters: 'WR2' });
        core.regulate();
        assert.deepStrictEqual(writes.map((w) => w[0]), [SET('g1', 'WR2')]);
        assert.ok(!core.watchedIds().has(SET('g1', 'WR1')));
    });
    await test('SoC-Hysterese und Limitwechsel', () => {
        const { core, put, pub } = mk();
        put('bms.0.SoC', 91); core.evaluate();
        assert.strictEqual(core.limitActive, true);
        assert.strictEqual(pub['g1.Limit_W'], 300);
        assert.strictEqual(pub['g1.Status'], true);
        put('bms.0.SoC', 87); core.evaluate();
        assert.strictEqual(core.limitActive, true);
        put('bms.0.SoC', 84); core.evaluate();
        assert.strictEqual(core.limitActive, false);
        assert.strictEqual(pub['g1.Limit_W'], 800);
        assert.strictEqual(pub.Akku_Voll, false);
    });
    await test('SoC: Limit bei vollem Akku regelt schärfer, ungültiger SoC behält Zustand', () => {
        const { core, put, writes, pub } = mk();
        put('bms.0.SoC', 95); core.evaluate();
        assert.ok(writes.length === 2); // Einspeisung 1000 W > 300 W
        writes.length = 0;
        put('bms.0.SoC', 'x'); core.evaluate();
        assert.strictEqual(core.limitActive, true);
        assert.strictEqual(pub['info.connection'], false);
    });
    await test('Ausgaben: Einspeisung, Zähler, Verbindung', () => {
        const { core, pub, put } = mk();
        core.evaluate();
        assert.strictEqual(pub['g1.Einspeisung_W'], 1000);
        assert.strictEqual(pub['g1.Zaehler_OK'], true);
        assert.strictEqual(pub['info.connection'], true);
        put(METER('g1'), null); core.onMeter();
        assert.strictEqual(pub['g1.Zaehler_OK'], false);
        assert.strictEqual(pub['info.connection'], false);
    });
    await test('Beobachtete IDs', () => {
        const { core } = mk();
        const ids = [...core.watchedIds()];
        assert.ok(ids.includes('bms.0.SoC') && ids.includes(METER('g1')) && ids.includes(ACT('g1', 'WR2')));
        assert.ok(core.isMeterId(METER('g1')) && !core.isMeterId('x'));
    });

    await test('Export/Import: Rundlauf', () => {
        const native = { ...DEFAULTS, socStart: 92, dryRun: true, groups: [{ group: 'a', active: true, limit: 700, limitFull: 250, meter: 'm', invert: true, inverters: 'WR1,WR2' }], configJson: 'alt' };
        const ex = exportConfig(native);
        const parsed = JSON.parse(ex.native.configJson);
        assert.strictEqual(parsed.adapter, 'netzlimit');
        assert.strictEqual(JSON.stringify(parsed).includes('alt'), false);
        const im = importConfig(ex.native.configJson);
        assert.strictEqual(im.error, undefined);
        assert.strictEqual(im.native.socStart, 92);
        assert.strictEqual(im.native.dryRun, true);
        assert.deepStrictEqual(im.native.groups, parsed.config.groups);
        assert.strictEqual(im.native.configJson, '');
    });
    await test('Import: reines config-Objekt und Gruppenzeilen', () => {
        const im = importConfig(JSON.stringify({ socId: 'x.0.SoC', groups: [{ group: 'a', meter: 'm' }, { group: 'b c' }] }));
        assert.strictEqual(im.native.socId, 'x.0.SoC');
        assert.strictEqual(im.native.groups.length, 1);
        assert.ok(im.result.includes('Übersprungen'));
    });
    await test('Import: Fehlerfälle', () => {
        assert.ok(importConfig('').error);
        assert.ok(importConfig('{kaputt').error);
        assert.ok(importConfig('[1]').error);
        assert.ok(importConfig('{"adapter":"shelly-gruppen","config":{}}').error);
        assert.ok(importConfig('{"version":9,"config":{}}').error);
        assert.ok(importConfig('{"config":{"groups":"x"}}').error);
        assert.ok(importConfig('{"config":{"socStart":50,"socEnd":60}}').error);
        assert.ok(importConfig('{"config":{"scale":0}}').error);
        assert.ok(importConfig('x'.repeat(200001)).error);
    });
    await test('Export: leere Konfiguration liefert Standardwerte', () => {
        const c = JSON.parse(exportConfig(undefined).native.configJson).config;
        assert.strictEqual(c.socId, DEFAULTS.socId);
        assert.deepStrictEqual(c.groups, []);
    });
    await test('io-package.json: Standardwerte passen zum Modell', () => {
        const io = require('../io-package.json');
        assert.deepStrictEqual({ ...io.native, configJson: undefined }, { ...DEFAULTS, configJson: undefined });
        assert.strictEqual(io.native.configJson, '');
        assert.strictEqual(require('../package.json').version, io.common.version);
        assert.deepStrictEqual(normalizeConfig(io.native, silent).errors, []);
    });
    console.log(`\n${passed} Tests bestanden`);
})().catch((e) => { console.error(e); process.exit(1); });
