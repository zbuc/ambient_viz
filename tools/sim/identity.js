// The 4A identity graph (MIGRATION_PLAN.md phase 4A).
//
// One Input -> Output echo chain per legacy-mapped bus path, publishing back
// to the SAME path at priority one step below the incumbent — exactly the
// shadow-by-priority shape every later candidate uses (doctrine: "legacy at
// the incumbent priority, candidate one step lower"). The 4A gate is that the
// echo stream equals the input stream packet-for-packet while arbitration
// keeps every incumbent winning.
//
// Authorization is deliberately NOT taken from the project policy: no real
// role may publish across sensor.* + touch.* + clock.* + ui.* (the spec's own
// example — "a sensor graph cannot emit clock.*"). The echo is a simulator
// harness construct, so the sim injects this clearly-named role and allowlist
// entry into its IN-MEMORY registry only, and says so in the report. The real
// `router` role (fx.* only) lands in policy.json with 4C.

'use strict';

const adapter = require('../../server/src/bus-adapter');

const SIM_SOURCE = 'spiffe://pain-material.local/sim/router-identity';
const SIM_ROLE = {
  name: 'sim_identity_echo',
  canPublish: ['*'],
  cannotPublish: [],
  canSubscribe: ['*'],
  maxPriority: 700, // ui echo sits at 699
};

function echoPaths() {
  // The echo must shadow the LOWEST possible incumbent on each path. For
  // near/far that is the adapter's standing defaults writer at the idle rung
  // (phase 4C) — when the sidecar is silent, an echo at sensor-1 would WIN
  // against the defaults and stop being a shadow.
  const endpointPaths = new Set([adapter.MAP.distance_near_cm.path, adapter.MAP.distance_far_cm.path]);
  return [
    ...Object.values(adapter.MAP).map((m) => ({
      path: m.path,
      priority: endpointPaths.has(m.path) ? adapter.PRIORITIES.PRI_IDLE - 1 : m.priority - 1,
    })),
    ...adapter.TOUCH.paths.map((p) => ({ path: p, priority: adapter.TOUCH.priority - 1 })),
  ];
}

function identityGraph() {
  const nodes = [];
  for (const { path, priority } of echoPaths()) {
    nodes.push({ id: `in:${path}`, rateDomain: 'RATE_CONTROL', input: { path } });
    nodes.push({
      id: `out:${path}`,
      rateDomain: 'RATE_CONTROL',
      output: { input: `in:${path}`, target: path, shape: 'STATE', priority, authorityRole: SIM_ROLE.name },
    });
  }
  return { schema: 'router.v1', nodes };
}

// In-memory overlay so the WARN-mode policy check recognizes the sim writer:
// a TrustedId-shaped record with the echo targets declared. Mutates only the
// loaded registry object, never the files.
function injectSimWriter(registry) {
  registry.policy.roles.push(SIM_ROLE);
  registry.bySourceId.set(SIM_SOURCE, {
    manifest: { identity: { stableId: SIM_SOURCE, instanceId: 'sim' }, publishes: [] },
    trusted: { stableId: SIM_SOURCE, role: SIM_ROLE.name, instanceId: 'sim' },
    role: SIM_ROLE,
    declared: new Map(echoPaths().map(({ path }) => [path, {}])),
    canPublish: [/^.*$/],
    cannotPublish: [],
  });
  return { source: SIM_SOURCE, role: SIM_ROLE.name };
}

module.exports = { identityGraph, injectSimWriter, echoPaths, SIM_SOURCE, SIM_ROLE };
