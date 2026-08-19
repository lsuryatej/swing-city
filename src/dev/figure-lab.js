/**
 * FIGURE LAB — the silhouette alone, big, in a spread of poses.
 *
 * The sandbox shows the character at play size against the city, which is the
 * right test for whether it READS but a useless one for judging the outline:
 * the figure is ~90px tall there. This page drives the same skeleton solver
 * through a set of held poses and draws each at 3x, which is the only way to
 * see whether a joint creases.
 *
 * Not in the vite build inputs — it is a dev tool, not a shipped page.
 */
import { createSkeleton } from '../sim/skeleton.js';
import { drawSilhouette } from '../render/silhouette.js';
import { BONES, JOINT_NAMES } from '../sim/skeleton.js';

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const dbg = document.getElementById('dbg');

/** hip, anchor offset, velocity, up-axis. One entry per cell. */
const POSES = [
  { label: 'hang', anchor: [40, -300], vel: [500, 0], up: [0.13, -0.99] },
  { label: 'bottom of arc', anchor: [-10, -320], vel: [1400, 40], up: [0.03, -1] },
  { label: 'release, rising', anchor: [-260, -220], vel: [1100, -900], up: [0.6, -0.8] },
  { label: 'dive', anchor: [0, -400], vel: [700, 1300], up: [-0.4, -0.92], attached: false },
  { label: 'flight, flat', anchor: [0, -400], vel: [1800, 0], up: [0.7, -0.71], attached: false },
  { label: 'fire, low speed', anchor: [300, -420], vel: [260, 300], up: [0.35, -0.94] },
];

// `?only=2` isolates one pose at 4x. The six-up grid is for spotting a
// regression across the range; the isolated view is for judging an outline.
const only = new URLSearchParams(location.search).get('only');
const list = only == null ? POSES : [POSES[Number(only) % POSES.length]];
const COLS = only == null ? 3 : 1;
const ROWS = only == null ? 2 : 1;
const CELL_W = 1600 / COLS;
const CELL_H = 900 / ROWS;
const FIG_SCALE = only == null ? 2.1 : 4.4;

function draw() {
  ctx.fillStyle = '#0a0c16';
  ctx.fillRect(0, 0, 1600, 900);

  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const skel = createSkeleton();
    const hip = { x: 0, y: 0 };
    const anchor = { x: p.anchor[0], y: p.anchor[1] };
    const vel = { x: p.vel[0], y: p.vel[1] };
    const up = { x: p.up[0], y: p.up[1] };
    const attached = p.attached !== false;
    // Settle the springs: they lag by design, so a single solve() shows the
    // rest pose rather than the pose being asked for.
    for (let k = 0; k < 120; k++) skel.solve({ hip, anchor, vel, up, attached }, 1 / 60);

    const cxp = (i % COLS) * CELL_W + CELL_W / 2;
    const cyp = Math.floor(i / COLS) * CELL_H + CELL_H / 2;

    ctx.save();
    ctx.translate(cxp, cyp + 30);
    ctx.scale(FIG_SCALE, FIG_SCALE);
    drawSilhouette(ctx, { joints: skel.joints }, {
      bodyColor: '#e9eefc',
      rimColor: '#2a3557',
      rimOffsetX: 2.6,
      rimOffsetY: 3.6,
    });

    if (dbg.checked) {
      ctx.lineWidth = 0.8;
      ctx.strokeStyle = '#ff3ea5';
      ctx.beginPath();
      for (const [a, b] of BONES) {
        ctx.moveTo(skel.joints[a].x, skel.joints[a].y);
        ctx.lineTo(skel.joints[b].x, skel.joints[b].y);
      }
      ctx.stroke();
      ctx.fillStyle = '#ffe14d';
      for (const n of JOINT_NAMES) {
        ctx.beginPath();
        ctx.arc(skel.joints[n].x, skel.joints[n].y, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    ctx.fillStyle = '#7f8ea8';
    ctx.font = '16px ui-monospace, Menlo, monospace';
    ctx.fillText(p.label, (i % COLS) * CELL_W + 20, Math.floor(i / COLS) * CELL_H + 30);
  }
}

dbg.addEventListener('change', draw);
draw();
