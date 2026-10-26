'use strict';
/**
 * Konfigurationsprüfung, Gruppen-Ermittlung und Standardwerte.
 * Reine Logik ohne ioBroker-Abhängigkeit (testbar).
 */
const SEG = /^[A-Za-z0-9_-]+$/;
const PATH = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
const WR_NAME = /^WR[A-Za-z0-9_-]*$/;
const OBJ_ID = /^[A-Za-z0-9_\-:]+(\.[A-Za-z0-9_\-:]+)+$/;

const DEFAULTS = {
    basis: '0_userdata.0.Wechselrichter',
    setpointState: 'Power',
    actualState: 'InvOutputWatts',
    scale: 1,
    socId: 'growatt-bms.0.SoC',
    socStart: 90,
    socEnd: 85,
    meterBase: 'shelly-gruppen.0',
    meterPowerState: 'info.Total_Power',
    meterOnlineState: '',
    meterMaxAgeS: 120,
    deadbandW: 15,
    excessDelayS: 30,
    intervalMs: 3000,
    dryRun: false,
    chargersEnabled: false,
    chargerMinW: 20,
    chargerWaitS: 120,
    chargerMaxAgeS: 120,
    groups: [],
    chargers: [],
};

const GROUP_DEFAULTS = { active: false, limit: 800, limitFull: 300, meter: '', invert: false, inverters: '' };

const CHARGER_DEFAULTS = { active: false, group: '', powerId: '', scale: 1, invert: false, maxW: 600, onlineId: '' };

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isNum = (v) => v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v));

/**
 * Prüft die komplette Konfiguration.
 * Fehler in globalen Werten landen in errors (Regelung bleibt aus); ungültige Gruppenzeilen werden
 * mit Warnung übersprungen.
 */
function normalizeConfig(native, log = silent) {
    const n = native || {};
    const errors = [];
    const warnings = [];
    const warn = (m) => { warnings.push(m); log.warn(m); };
    const cfg = {};

    const text = (key, label, re, allowEmpty) => {
        const v = String(n[key] === undefined || n[key] === null ? DEFAULTS[key] : n[key]).trim();
        if (v === '' && allowEmpty) { cfg[key] = ''; return; }
        if (!re.test(v)) { errors.push(`${label} „${v}“ ist ungültig (erlaubt: A-Z, 0-9, _, -${re === PATH ? ', Punkt als Trenner' : ''})`); cfg[key] = DEFAULTS[key]; return; }
        cfg[key] = v;
    };
    const number = (key, label, min, max, integer) => {
        const raw = n[key] === undefined || n[key] === '' ? DEFAULTS[key] : n[key];
        const v = Number(raw);
        if (!Number.isFinite(v) || v < min || v > max) { errors.push(`${label} muss zwischen ${min} und ${max} liegen (ist: ${raw})`); cfg[key] = DEFAULTS[key]; return; }
        cfg[key] = integer ? Math.round(v) : v;
    };

    text('basis', 'Basis-Pfad der Wechselrichter', PATH);
    text('setpointState', 'Sollwert-Datenpunkt', SEG);
    text('actualState', 'Istwert-Datenpunkt', SEG);
    text('socId', 'Datenpunkt des Akku-SoC', PATH);
    text('meterBase', 'Basis-Pfad der Zähler', PATH);
    text('meterPowerState', 'Leistungs-Datenpunkt des Zählers', PATH);
    text('meterOnlineState', 'Online-Datenpunkt des Zählers', PATH, true);
    number('scale', 'Skalierung', 0.000001, 1000000);
    number('socStart', 'SoC-Start', 1, 100);
    number('socEnd', 'SoC-Ende', 0, 99);
    number('deadbandW', 'Totband', 0, 1000);
    number('excessDelayS', 'Einschaltverzögerung', 0, 3600, true);
    number('intervalMs', 'Regeltakt', 500, 60000, true);
    number('meterMaxAgeS', 'Maximales Alter des Zählerwerts', 0, 3600, true);
    number('chargerMinW', 'Mindest-Ladeleistung', 0, 10000);
    number('chargerWaitS', 'Max. Wartezeit auf Ladegeräte', 0, 3600, true);
    number('chargerMaxAgeS', 'Maximales Alter des Ladegeräte-Werts', 0, 3600, true);
    cfg.dryRun = n.dryRun === true || n.dryRun === 'true';
    cfg.chargersEnabled = n.chargersEnabled === true || n.chargersEnabled === 'true';
    if (cfg.socEnd >= cfg.socStart) errors.push(`SoC-Ende (${cfg.socEnd} %) muss kleiner als SoC-Start (${cfg.socStart} %) sein`);

    cfg.groups = [];
    const seen = new Set();
    for (const [i, row] of (Array.isArray(n.groups) ? n.groups : []).entries()) {
        const where = `Gruppe, Zeile ${i + 1}`;
        const group = String((row && row.group) || '').trim();
        if (!group && !(row && (row.meter || row.inverters))) continue;
        if (!SEG.test(group)) { warn(`${where}: Gruppenname „${group}“ ungültig – übersprungen`); continue; }
        if (seen.has(group)) { warn(`${where}: Gruppe ${group} doppelt – übersprungen`); continue; }
        const limit = isNum(row.limit) ? Number(row.limit) : GROUP_DEFAULTS.limit;
        const limitFull = isNum(row.limitFull) ? Number(row.limitFull) : GROUP_DEFAULTS.limitFull;
        if (limit < 0 || limit > 100000 || limitFull < 0 || limitFull > 100000) { warn(`${where} (${group}): Limits müssen zwischen 0 und 100000 W liegen – übersprungen`); continue; }
        const meter = String(row.meter || '').trim();
        if (meter && !SEG.test(meter)) { warn(`${where} (${group}): Zähler „${meter}“ ungültig – übersprungen`); continue; }
        const inverters = String(row.inverters || '').split(',').map((s) => s.trim()).filter(Boolean);
        const badWr = inverters.find((w) => !WR_NAME.test(w));
        if (badWr) { warn(`${where} (${group}): Wechselrichter „${badWr}“ ungültig (erwartet WR…) – übersprungen`); continue; }
        seen.add(group);
        cfg.groups.push({ group, active: row.active === true || row.active === 'true', limit, limitFull, meter, invert: row.invert === true || row.invert === 'true', inverters });
    }

    cfg.chargers = [];
    const names = new Set();
    for (const [i, row] of (Array.isArray(n.chargers) ? n.chargers : []).entries()) {
        const where = `Ladegerät, Zeile ${i + 1}`;
        const name = String((row && row.name) || '').trim();
        if (!name && !(row && (row.powerId || row.group))) continue;
        if (!SEG.test(name)) { warn(`${where}: Name „${name}“ ungültig – übersprungen`); continue; }
        if (names.has(name)) { warn(`${where}: Ladegerät ${name} doppelt – übersprungen`); continue; }
        const group = String(row.group || '').trim();
        if (!seen.has(group)) { warn(`${where} (${name}): Gruppe „${group}“ ist nicht konfiguriert – übersprungen`); continue; }
        const powerId = String(row.powerId || '').trim();
        if (!OBJ_ID.test(powerId)) { warn(`${where} (${name}): Leistungs-Datenpunkt „${powerId}“ ungültig – übersprungen`); continue; }
        const onlineId = String(row.onlineId || '').trim();
        if (onlineId && !OBJ_ID.test(onlineId)) { warn(`${where} (${name}): Online-Datenpunkt „${onlineId}“ ungültig – übersprungen`); continue; }
        const maxW = isNum(row.maxW) ? Number(row.maxW) : CHARGER_DEFAULTS.maxW;
        if (maxW <= 0 || maxW > 100000) { warn(`${where} (${name}): Max. Ladeleistung muss zwischen 1 und 100000 W liegen – übersprungen`); continue; }
        const scale = isNum(row.scale) ? Number(row.scale) : CHARGER_DEFAULTS.scale;
        if (scale <= 0 || scale > 1000000) { warn(`${where} (${name}): Skalierung muss größer als 0 sein – übersprungen`); continue; }
        names.add(name);
        cfg.chargers.push({ name, active: row.active === true || row.active === 'true', group, powerId, scale, invert: row.invert === true || row.invert === 'true', maxW, onlineId });
    }
    return { cfg, errors, warnings };
}

/** Zeilen der Gruppentabelle (für Export und Admin-Oberfläche). */
const rowsOf = (groups) => groups.map((g) => ({ group: g.group, active: g.active, limit: g.limit, limitFull: g.limitFull, meter: g.meter, invert: g.invert, inverters: g.inverters.join(',') }));

/** Zeilen der Ladegeräte-Tabelle. */
const chargerRowsOf = (chargers) => chargers.map((c) => ({ name: c.name, active: c.active, group: c.group, powerId: c.powerId, scale: c.scale, invert: c.invert, maxW: c.maxW, onlineId: c.onlineId }));

/** Zerlegt Objekt-IDs <basis>.<gruppe>.WR<x>.<sollwert> in { gruppe: [IDs] }. */
function parseTopology(ids, basis, setpointState) {
    const re = new RegExp(`^${esc(basis)}\\.([^.]+)\\.(WR[^.]*)\\.${esc(setpointState)}$`);
    const found = {};
    for (const id of ids) {
        const m = re.exec(id);
        if (m) (found[m[1]] = found[m[1]] || []).push(id);
    }
    for (const g of Object.keys(found)) found[g].sort();
    return found;
}

/** Ergänzt die Tabelle um gefundene, noch nicht eingetragene Gruppen (inaktiv, Standard-Limits). */
function mergeDiscovered(rows, found) {
    const out = (Array.isArray(rows) ? rows : []).map((r) => ({ ...r }));
    const have = new Set(out.map((r) => String(r.group || '').trim()));
    const added = [];
    for (const g of Object.keys(found).sort()) {
        if (have.has(g)) continue;
        const m = /wohnung_(links|rechts)$/.exec(g);
        out.push({ group: g, ...GROUP_DEFAULTS, meter: m ? `wohnung_${m[1]}` : '' });
        added.push(g);
    }
    return { rows: out, added };
}

module.exports = { DEFAULTS, GROUP_DEFAULTS, CHARGER_DEFAULTS, normalizeConfig, rowsOf, chargerRowsOf, parseTopology, mergeDiscovered };
