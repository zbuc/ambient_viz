// Phase-3 manifest registry + ProjectPolicy, WARN mode (MIGRATION_PLAN.md).
//
// Loads the project's ModuleManifests + ProjectPolicy (proto-JSON, validated
// through the generated manifest.v1 codecs), registers every declared signal
// on the bus (type / stale window / range / queue bounds now come from the
// manifest — the declaration the packets stay lean by omitting), and installs
// the WARN-mode policy check:
//
//   - publisher's stable_id must be on the project allowlist (TrustedId);
//   - the path must match the bound role's can_publish globs (with
//     ${instance} expanded) and none of its cannot_publish globs;
//   - the path must be declared in the module's manifest publishes;
//   - the packet priority must not exceed the role's max_priority.
//
// Every check is OBSERVATIONAL: runtime_modes are all WARN/OFF in phase 3, so
// a violation annotates the packet's enforcement truth values, increments the
// path's warn counter, and lands in the inspector's triage feed — it never
// rejects. `_meta.*` is exempt (reserved bus-internal domain).
//
// Load-time validation (manifest hygiene, reported as load warnings):
// duplicate stable_id / instance_id across manifests, allow entries naming
// unknown roles, instance_id disagreeing with the TrustedId binding, unit
// tokens outside the project-pinned list, claimed roles with no binding.

'use strict';

const fs = require('fs');
const path = require('path');

const manifestGen = require('./gen/manifest');

// generated enum number -> bus.js declaredType string
const VALUE_TYPE_NAME = { 1: 'float', 2: 'int', 3: 'bool', 4: 'text', 5: 'vec', 6: 'blob' };
const MODE_NAME = { 0: 'UNSPECIFIED', 1: 'OFF', 2: 'WARN', 3: 'ENFORCE' };
const SIG_NAME = { 0: 'UNSPECIFIED', 1: 'NONE', 2: 'HMAC', 3: 'MTLS' };

function globToRegex(glob, instance) {
  const expanded = glob.replace(/\$\{instance\}/g, instance || '');
  return new RegExp('^' + expanded.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
}

function loadRegistry(dir) {
  const warnings = [];
  const policy = manifestGen.ProjectPolicy.fromJSON(
    JSON.parse(fs.readFileSync(path.join(dir, 'policy.json'), 'utf8')),
  );
  let unitTokens = null;
  try { unitTokens = JSON.parse(fs.readFileSync(path.join(dir, 'units.json'), 'utf8')); }
  catch { warnings.push('no units.json — unit tokens unchecked'); }

  const modulesDir = path.join(dir, 'modules');
  const modules = [];
  for (const f of fs.readdirSync(modulesDir).filter((x) => x.endsWith('.json')).sort()) {
    try {
      modules.push(manifestGen.ModuleManifest.fromJSON(
        JSON.parse(fs.readFileSync(path.join(modulesDir, f), 'utf8')),
      ));
    } catch (e) {
      warnings.push(`manifest ${f} unparseable: ${e.message}`);
    }
  }

  const roles = new Map(policy.roles.map((r) => [r.name, r]));
  const allowById = new Map(policy.allow.map((t) => [t.stableId, t]));

  // Duplicate-id handling + binding hygiene.
  const seenStable = new Set();
  const seenInstance = new Map(); // instance_id -> stable_id
  const bySourceId = new Map();
  for (const m of modules) {
    const id = m.identity;
    if (seenStable.has(id.stableId)) {
      warnings.push(`duplicate stable_id ${id.stableId} — second manifest ignored`);
      continue;
    }
    seenStable.add(id.stableId);
    if (seenInstance.has(id.instanceId)) {
      warnings.push(`duplicate instance_id "${id.instanceId}" (${id.stableId} vs ${seenInstance.get(id.instanceId)})`);
    }
    seenInstance.set(id.instanceId, id.stableId);

    const trusted = allowById.get(id.stableId) || null;
    if (!trusted) warnings.push(`${id.stableId} has a manifest but no allowlist entry — its packets will WARN`);
    else if (trusted.instanceId !== id.instanceId) {
      warnings.push(`${id.stableId}: manifest instance_id "${id.instanceId}" != allowlist binding "${trusted.instanceId}"`);
    }
    if (trusted && !roles.has(trusted.role)) warnings.push(`${id.stableId}: allowlist role "${trusted.role}" not defined in policy`);
    if (m.role && trusted && m.role !== trusted.role) {
      warnings.push(`${id.stableId}: claims role "${m.role}", policy binds "${trusted.role}" — policy wins`);
    }

    if (unitTokens) {
      for (const d of m.publishes) {
        if (d.unit && !unitTokens.includes(d.unit)) {
          warnings.push(`${id.stableId}: unit "${d.unit}" on ${d.path} not in the project-pinned token list`);
        }
      }
    }

    const role = trusted ? roles.get(trusted.role) || null : null;
    bySourceId.set(id.stableId, {
      manifest: m,
      trusted,
      role,
      declared: new Map(m.publishes.map((d) => [d.path, d])),
      canPublish: role ? role.canPublish.map((g) => globToRegex(g, trusted.instanceId)) : [],
      cannotPublish: role ? role.cannotPublish.map((g) => globToRegex(g, trusted.instanceId)) : [],
    });
  }

  const modes = {
    auth: MODE_NAME[policy.runtimeModes ? policy.runtimeModes.auth : 0],
    signature: SIG_NAME[policy.runtimeModes ? policy.runtimeModes.signature : 0],
    priority: MODE_NAME[policy.runtimeModes ? policy.runtimeModes.priority : 0],
    time_sync: MODE_NAME[policy.runtimeModes ? policy.runtimeModes.timeSync : 0],
  };

  return { policy, modules, bySourceId, modes, warnings, project: policy.project };
}

// Register every declared signal on the bus and install the WARN-mode check.
function applyRegistry(registry, bus) {
  for (const rec of registry.bySourceId.values()) {
    for (const d of rec.manifest.publishes) {
      bus.registerPath(d.path, {
        shape: d.shape === 2 ? 'event' : 'state',
        type: VALUE_TYPE_NAME[d.valueType] || null,
        staleAfterMs: d.staleAfterMs || 0,
        maxQueue: d.maxQueue || undefined,
        range: d.range ? { min: d.range.min, max: d.range.max } : null,
      });
    }
  }

  bus.setPolicy((pkt, sigPath) => {
    if (sigPath.startsWith('_meta.')) return null; // reserved domain, exempt
    const src = pkt.source.sourceId;
    const rec = registry.bySourceId.get(src);
    const reasons = [];
    if (!rec || !rec.trusted) {
      reasons.push(`source ${src} not on the project allowlist`);
    } else {
      if (!rec.role) reasons.push(`role "${rec.trusted.role}" undefined in policy`);
      else {
        if (!rec.canPublish.some((re) => re.test(sigPath))) {
          reasons.push(`path not in role "${rec.role.name}" can_publish`);
        }
        if (rec.cannotPublish.some((re) => re.test(sigPath))) {
          reasons.push(`path matches role "${rec.role.name}" cannot_publish`);
        }
        if ((pkt.priority || 0) > rec.role.maxPriority) {
          reasons.push(`priority ${pkt.priority} exceeds role ceiling ${rec.role.maxPriority}`);
        }
      }
      if (!rec.declared.has(sigPath)) reasons.push('path not declared in module manifest publishes');
    }
    return { ok: reasons.length === 0, reasons };
  });
}

module.exports = { loadRegistry, applyRegistry };
