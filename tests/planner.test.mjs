import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../public/planner.js', import.meta.url), 'utf8');
const sandbox = { window: {}, console };
vm.runInNewContext(source, sandbox);
const P = sandbox.window.RH_DJ_PLANNER;
assert.ok(P, 'planner loaded');

const section = (start, end, kind, energy) => ({ start, end, kind, energy });
const a = {
  id: 'A', duration: 240, bpm: 128, key: '8A', energy: 0.72, vocalRisk: 0.3,
  introEnd: 20, outroStart: 200, beatOffset: 0.2,
  sections: [section(0, 30, 'intro', .5), section(30, 90, 'verse', .7), section(90, 150, 'drop', .95), section(150, 200, 'drop', .9), section(200, 240, 'outro', .6)],
};
const b = {
  id: 'B', duration: 220, bpm: 126, key: '9A', energy: 0.7, vocalRisk: 0.35,
  introEnd: 18, outroStart: 190, beatOffset: 0.1,
  sections: [section(0, 24, 'intro', .45), section(24, 80, 'verse', .7), section(80, 150, 'drop', .92), section(150, 220, 'outro', .6)],
};
const plan = P.plan(a, b);
assert.ok(plan, 'plan returned');
assert.ok(plan.transitionStartA > 0 && plan.transitionStartA < a.duration - 2, 'start A within A');
assert.ok(plan.transitionStartB >= 0 && plan.transitionStartB < b.duration - 2, 'start B within B');
assert.ok(plan.transitionDuration > 0, 'positive duration');
assert.ok(plan.transitionStartA + plan.transitionDuration <= a.duration, 'transition fits inside A');
assert.ok(plan.automation && plan.automation.outgoingVolume.length === 129, 'gain automation');
assert.ok(plan.automation.lowEQ && plan.automation.lowEQ.in.length === 129, 'EQ automation');
assert.ok(plan.strategy, 'strategy');
assert.equal(P.nextInOrder([a, b, { id: 'C' }], a).id, 'B');
assert.equal(P.nextInOrder([a, b, { id: 'C' }], { id: 'C' }).id, 'A');

// The start in A must not depend on B duration or B being finished.
const shorterB = { ...b, duration: 120, sections: b.sections.map((s) => ({ ...s, end: Math.min(s.end, 120) })) };
const plan2 = P.plan(a, shorterB);
assert.ok(plan2.transitionStartA > 0);
assert.ok(plan2.transitionStartB < shorterB.duration - 2);
console.log('planner tests passed:', { startA: plan.transitionStartA.toFixed(1), startB: plan.transitionStartB.toFixed(1), duration: plan.transitionDuration.toFixed(1), strategy: plan.strategy });
