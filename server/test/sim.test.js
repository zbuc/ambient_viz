// Graph simulator tests (phase 4A, MIGRATION_PLAN.md): compile validation,
// end-to-end identity on a synthetic capture, determinism (two runs ->
// byte-identical logs). The 63-minute golden gate runs via tools/sim/sim.js
// directly; these tests keep the machinery honest at unit scale.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { compileGraph } = require('../src/router-graph');
const { identityGraph } = require('../../tools/sim/identity');
const { runSim } = require('../../tools/sim/sim');

// ── compile validation ────────────────────────────────────────────────────

const ROLES = new Map([['r', { name: 'r', canPublish: ['*'], cannotPublish: ['safety.*'], maxPriority: 500 }]]);
const IN = (id, p) => ({ id, rateDomain: 'RATE_CONTROL', input: { path: p } });
const OUT = (id, input, target, priority = 100) => ({
  id, rateDomain: 'RATE_CONTROL',
  output: { input, target, shape: 'STATE', priority, authorityRole: 'r' },
});

test('compile: valid echo graph passes', () => {
  const c = compileGraph({ schema: 'router.v1', nodes: [IN('a', 'sensor.x.v'), OUT('b', 'a', 'sensor.x.v')] }, { roles: ROLES });
  assert.ok(c.ok, c.errors.join('; '));
  assert.deepStrictEqual(c.topo, ['a', 'b']);
});

test('compile: rejections', () => {
  const cases = [
    [{ schema: 'nope', nodes: [] }, /schema/],
    [{ schema: 'router.v1', nodes: [IN('a', 's.x'), IN('a', 's.y')] }, /duplicate node id/],
    [{ schema: 'router.v1', nodes: [{ id: 'a', rateDomain: 'RATE_CONTROL' }] }, /exactly one op/],
    [{ schema: 'router.v1', nodes: [OUT('b', 'ghost', 's.x')] }, /unknown node "ghost"/],
    [{ schema: 'router.v1', nodes: [{ id: 'a', rateDomain: 'RATE_RENDER_FRAME', input: { path: 's.x' } }] }, /RATE_CONTROL/],
    [{ schema: 'router.v1', nodes: [{ id: 'a', rateDomain: 'RATE_CONTROL', smooth: { input: 'a', kind: 'ONE_POLE' } }] }, /not implemented in 4A/],
    [{ schema: 'router.v1', nodes: [IN('a', 'audio.*.bass')] }, /wildcards/],
    [{ schema: 'router.v1', nodes: [IN('a', '_meta.s.rate_hz')] }, /_meta/],
    [{ schema: 'router.v1', nodes: [IN('a', 's.x'), { id: 'b', rateDomain: 'RATE_CONTROL', output: { input: 'a', target: 's.x', shape: 'EVENT', priority: 1, authorityRole: 'r' } }] }, /STATE outputs/],
    [{ schema: 'router.v1', nodes: [IN('a', 's.x'), OUT('b', 'a', 's.x', 900)] }, /exceeds role/],
    [{ schema: 'router.v1', nodes: [IN('a', 's.x'), OUT('b', 'a', 'safety.kill', 100)] }, /cannot_publish/],
    [{ schema: 'router.v1', nodes: [], reps: [{ bind: '${i}' }] }, /Replicated/],
  ];
  for (const [graph, re] of cases) {
    const c = compileGraph(graph, { roles: ROLES });
    assert.ok(!c.ok, `expected rejection: ${re}`);
    assert.ok(c.errors.some((e) => re.test(e)), `expected /${re.source}/ in: ${c.errors.join(' | ')}`);
  }
});

test('compile: cycle without Delay is an error', () => {
  // Two outputs can't form a cycle in the 4A op set, so wire a fake op pair
  // through the dependency table by abusing output->input refs: a->b->a is
  // impossible with input/output only; instead check the Kahn guard with a
  // self-referencing output input (output reading its own id).
  const c = compileGraph({
    schema: 'router.v1',
    nodes: [{ id: 'b', rateDomain: 'RATE_CONTROL', output: { input: 'b', target: 's.x', shape: 'STATE', priority: 1, authorityRole: 'r' } }],
  }, { roles: ROLES });
  assert.ok(!c.ok);
  assert.ok(c.errors.some((e) => /cycle/.test(e)), c.errors.join(' | '));
});

// ── end-to-end on a synthetic capture ─────────────────────────────────────

function writeSyntheticGolden(root) {
  const dir = path.join(root, 'golden-synth');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    format_version: 1, session_id: 'synth', boot_epoch_ms: 0, boot_mono_ms: 50,
    pid: 0, node: process.version, platform: 'test', git_sha: null, env: {}, config: {},
  }));
  const ev = [];
  let seq = 0;
  const push = (t, kind, fields) => ev.push(JSON.stringify({ seq: ++seq, t_mono_ms: t, t_wall_ms: t, kind, ...fields }));
  push(100, 'ingest', { items: [{ name: 'distance_cm', value: 120.5 }, { name: 'distance_velocity_cm_s', value: -1.25 }] });
  push(150, 'serial_rx', { raw: 'POS 1.000', decoded: { type: 'pos', sec: 1.0 } });
  push(200, 'ingest', { items: [{ name: 'distance_cm', value: 120.5 }] });        // legacy publish() dedupes this
  push(250, 'ingest', { items: [{ name: 'touch_mask', value: 5 }] });             // e0+e2 -> 12 first-time electrode publishes
  push(300, 'ingest', { items: [{ name: 'motion', value: 1 }] });                 // int -> bool coercion in the adapter
  push(2600, 'ingest', { items: [{ name: 'distance_cm', value: 80 }] });          // the 2.4 s gap forces virtual keepalives
  push(2700, 'serial_rx', { raw: 'RESET 0.000', decoded: { type: 'reset', sec: 0 } });
  push(2750, 'ingest_drop', { reason: 'bad_json', raw: '{nope' });                // produced no inputs live; pump must skip it
  fs.writeFileSync(path.join(dir, 'events.jsonl'), ev.join('\n') + '\n');
  return dir;
}

test('identity sim on a synthetic capture: MATCH, keepalives included', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-sim-'));
  const goldenDir = writeSyntheticGolden(root);
  const { report } = runSim({
    goldenDir, graphJson: identityGraph(), identityCheck: true,
    outDir: path.join(root, 'run1'), quiet: true,
  });

  assert.strictEqual(report.verdict, 'MATCH');
  assert.strictEqual(report.inputs.pump_deduped, 1);
  assert.strictEqual(report.inputs.pump_emitted, 7); // 2 + pos + touch_mask + motion + distance + reset
  // Adapter fanout: distance+velocity+pos+12 electrodes+motion+distance+pos(reset)=18, plus forced keepalives in the gap.
  assert.ok(report.packets.graph_published >= 18, `graph_published ${report.packets.graph_published}`);
  assert.ok(report.packets.graph_published > 18, 'expected at least one keepalive resend in the 2.4 s gap');
  assert.strictEqual(report.identity.mismatch_count, 0);
  assert.strictEqual(report.identity.missing_echoes, 0);
  assert.strictEqual(report.identity.extra_echoes, 0);
  assert.strictEqual(report.packets.rejected, 0);
  assert.strictEqual(report.packets.policy_warns, 0);
  assert.strictEqual(report.arbitration.violations.length, 0);
  // Shadow visibility: every echo candidate reads as a pre-cutover shadow.
  for (const [p, status] of Object.entries(report.arbitration.echo_candidate_status)) {
    assert.ok(['would_win_if_priority_ge_legacy', 'shadowed_by_higher_priority', 'stale'].includes(status),
      `${p}: unexpected echo status ${status}`);
  }
  // _meta flowed (virtual 1 Hz over ~2.7 s -> 2 ticks).
  assert.ok(report.packets.meta_logged > 0);
});

test('determinism: two runs produce byte-identical logs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-sim-'));
  const goldenDir = writeSyntheticGolden(root);
  const a = path.join(root, 'runA');
  const b = path.join(root, 'runB');
  runSim({ goldenDir, graphJson: identityGraph(), identityCheck: true, outDir: a, quiet: true });
  runSim({ goldenDir, graphJson: identityGraph(), identityCheck: true, outDir: b, quiet: true });
  for (const f of ['signals.jsonl', 'meta.jsonl']) {
    assert.ok(fs.readFileSync(path.join(a, f)).equals(fs.readFileSync(path.join(b, f))), `${f} differs between runs`);
  }
});
