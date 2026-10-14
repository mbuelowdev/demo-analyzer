// R-CD-2: pluggable visibility. v1 uses the game's own spotted mask; ray casting against
// uploaded map geometry can implement the same interface later.
import { at, type TickData } from './load.ts';

export interface VisibilityModel {
  id: string;
  /** Can `observer` see `target` at `tick`? */
  visible(observer: number, target: number, tick: number): boolean;
}

export class SpottedMaskVisibility implements VisibilityModel {
  id = 'spotted-mask-v1';
  constructor(private td: TickData) {}
  visible(observer: number, target: number, tick: number): boolean {
    return ((this.td.spottedBy[at(this.td, target, tick)] >>> observer) & 1) === 1;
  }
}
