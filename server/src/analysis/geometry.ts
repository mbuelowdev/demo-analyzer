// R-CD-3: view-angle helpers. Source engine conventions: yaw in degrees around Z, pitch positive = looking down.
import { at, type TickData } from './load.ts';

export const TICK_RATE = 64;
export const MS_PER_TICK = 1000 / TICK_RATE;
/** weapon_recoil_scale: bullets go where eye angles + 2 × aim punch point. */
export const RECOIL_SCALE = 2;

const STAND_EYE = 64;
const DUCK_EYE = 46;
/** Head centre sits a few units below eye height. */
const HEAD_BELOW_EYE = 2;
const BODY_BELOW_EYE = 24;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function rad(d: number) {
  return (d * Math.PI) / 180;
}
export function deg(r: number) {
  return (r * 180) / Math.PI;
}

/** Wraps an angle difference to [-180, 180). */
export function wrap180(a: number): number {
  return ((((a + 180) % 360) + 360) % 360) - 180;
}

export function eyePos(td: TickData, p: number, tick: number): Vec3 | null {
  const i = at(td, p, tick);
  const x = td.f.x[i];
  if (Number.isNaN(x)) return null;
  return { x, y: td.f.y[i], z: td.f.z[i] + (td.flags.ducking[i] ? DUCK_EYE : STAND_EYE) };
}

export function headPos(td: TickData, p: number, tick: number): Vec3 | null {
  const e = eyePos(td, p, tick);
  return e && { x: e.x, y: e.y, z: e.z - HEAD_BELOW_EYE };
}

export function bodyPos(td: TickData, p: number, tick: number): Vec3 | null {
  const e = eyePos(td, p, tick);
  return e && { x: e.x, y: e.y, z: e.z - BODY_BELOW_EYE };
}

export function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}

/** View angles (pitch, yaw) that point from `from` to `to`. */
export function anglesTo(from: Vec3, to: Vec3): { pitch: number; yaw: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  return { pitch: -deg(Math.atan2(dz, Math.hypot(dx, dy))), yaw: deg(Math.atan2(dy, dx)) };
}

/** Great-circle angle between two view directions, in degrees. */
export function angleBetween(p1: number, y1: number, p2: number, y2: number): number {
  const a = rad(p1);
  const b = rad(p2);
  const dYaw = rad(wrap180(y2 - y1));
  // Pitch is negated elevation; cos is even so the sign doesn't matter for the dot product except in sin terms.
  const c = Math.sin(a) * Math.sin(b) + Math.cos(a) * Math.cos(b) * Math.cos(dYaw);
  return deg(Math.acos(Math.min(1, Math.max(-1, c))));
}

export function viewAngles(td: TickData, p: number, tick: number, compensateRecoil = false): { pitch: number; yaw: number } | null {
  const i = at(td, p, tick);
  let pitch = td.f.pitch[i];
  let yaw = td.f.yaw[i];
  if (Number.isNaN(pitch) || Number.isNaN(yaw)) return null;
  if (compensateRecoil) {
    const pp = td.f.aim_punch_pitch[i];
    const py = td.f.aim_punch_yaw[i];
    if (!Number.isNaN(pp)) pitch += RECOIL_SCALE * pp;
    if (!Number.isNaN(py)) yaw += RECOIL_SCALE * py;
  }
  return { pitch, yaw };
}

/** Angular distance from attacker's crosshair to a point on the victim (head by default). */
export function aimError(td: TickData, attacker: number, victim: number, tick: number, opts: { recoil?: boolean; target?: 'head' | 'body' } = {}): number | null {
  const eye = eyePos(td, attacker, tick);
  const tgt = opts.target === 'body' ? bodyPos(td, victim, tick) : headPos(td, victim, tick);
  const view = viewAngles(td, attacker, tick, opts.recoil);
  if (!eye || !tgt || !view) return null;
  const want = anglesTo(eye, tgt);
  return angleBetween(view.pitch, view.yaw, want.pitch, want.yaw);
}

/** Angular speed of the view between two ticks, in degrees per second. */
export function viewSpeed(td: TickData, p: number, t0: number, t1: number): number | null {
  const a = viewAngles(td, p, t0);
  const b = viewAngles(td, p, t1);
  if (!a || !b || t1 === t0) return null;
  return angleBetween(a.pitch, a.yaw, b.pitch, b.yaw) / ((t1 - t0) / TICK_RATE);
}

/** Approximate angular radius of a hitbox at a distance (head ≈ 5 units, torso ≈ 11 units). */
export function hitboxRadiusDeg(distance: number, target: 'head' | 'body'): number {
  return deg(Math.atan((target === 'head' ? 5 : 11) / Math.max(1, distance)));
}

export function speed2d(td: TickData, p: number, tick: number): number {
  const i = at(td, p, tick);
  const vx = td.f.vel_x[i];
  const vy = td.f.vel_y[i];
  return Number.isNaN(vx) ? 0 : Math.hypot(vx, vy);
}

/** Distance from point p to the segment a–b. */
export function pointSegmentDistance(p: Vec3, a: Vec3, b: Vec3): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = len2 > 0 ? ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(a.x + t * abx - p.x, a.y + t * aby - p.y, a.z + t * abz - p.z);
}

export function weaponClass(name: string | null | undefined): 'rifle' | 'sniper' | 'smg' | 'pistol' | 'heavy' | 'other' {
  if (!name) return 'other';
  const n = name.toLowerCase().replace(/^weapon_/, '');
  if (/(awp|ssg ?08|scar|g3sg1)/.test(n)) return 'sniper';
  if (/(ak-?47|m4a1|m4a4|aug|sg ?553|sg556|famas|galil)/.test(n)) return 'rifle';
  if (/(mp9|mp7|mp5|mac-?10|ump|p90|bizon|pp-bizon)/.test(n)) return 'smg';
  if (/(glock|usp|p2000|hkp2000|p250|five-?seven|fiveseven|tec-?9|cz75|deagle|desert eagle|dual|elite|revolver|r8)/.test(n)) return 'pistol';
  if (/(nova|xm1014|mag-?7|sawed|negev|m249)/.test(n)) return 'heavy';
  return 'other';
}

export function isGun(name: string | null | undefined): boolean {
  return weaponClass(name) !== 'other';
}

export function distanceBand(d: number): 'close' | 'mid' | 'long' {
  return d < 600 ? 'close' : d < 1500 ? 'mid' : 'long';
}
