import { BattleState, Player, SNAKE } from "@extract/shared";

type BotMode = "seek" | "chase" | "flee";

const CHASE_RADIUS = 400;
const FLEE_RADIUS = 220;

export class BotController {
  private mode: BotMode = "seek";
  private targetX = 0;
  private targetY = 0;
  private rethinkAt = 0;

  constructor(public sessionId: string) {}

  update(self: Player, state: BattleState, dtMs: number) {
    if (!self.alive) return;
    const now = state.clockMs;
    if (now < this.rethinkAt) {
      this.steerToward(self, this.targetX, this.targetY);
      return;
    }
    this.rethinkAt = now + 250 + Math.random() * 250;

    const myMass = BigInt(self.massUnits);
    let nearestThreat: Player | null = null;
    let nearestThreatDist = Infinity;
    let nearestPrey: Player | null = null;
    let nearestPreyDist = Infinity;

    for (const p of state.players.values()) {
      if (!p.alive) continue;
      if (p.sessionId === self.sessionId) continue;
      const d = Math.hypot(p.headX - self.headX, p.headY - self.headY);
      if (d > CHASE_RADIUS) continue;
      const theirMass = BigInt(p.massUnits);
      if (theirMass > myMass + myMass / 4n) {
        if (d < nearestThreatDist) {
          nearestThreatDist = d;
          nearestThreat = p;
        }
      } else if (theirMass + theirMass / 4n < myMass) {
        if (d < nearestPreyDist) {
          nearestPreyDist = d;
          nearestPrey = p;
        }
      }
    }

    if (nearestThreat && nearestThreatDist < FLEE_RADIUS) {
      this.mode = "flee";
      this.targetX = self.headX - (nearestThreat.headX - self.headX);
      this.targetY = self.headY - (nearestThreat.headY - self.headY);
      self.boost = nearestThreatDist < FLEE_RADIUS / 1.5;
    } else if (nearestPrey) {
      this.mode = "chase";
      // Aim slightly ahead of prey
      this.targetX = nearestPrey.headX + Math.cos(nearestPrey.angle) * 60;
      this.targetY = nearestPrey.headY + Math.sin(nearestPrey.angle) * 60;
      self.boost = nearestPreyDist < CHASE_RADIUS / 2;
    } else {
      this.mode = "seek";
      // pick the nearest orb
      let best: { x: number; y: number; d: number } | null = null;
      let i = 0;
      for (const o of state.orbs.values()) {
        if (++i > 200) break; // sample cap
        const d = Math.hypot(o.x - self.headX, o.y - self.headY);
        if (!best || d < best.d) best = { x: o.x, y: o.y, d };
      }
      if (best) {
        this.targetX = best.x;
        this.targetY = best.y;
      } else {
        this.targetX = 0;
        this.targetY = 0;
      }
      self.boost = false;
    }

    // Avoid the zone border
    const dz = Math.hypot(self.headX - state.zone.cx, self.headY - state.zone.cy);
    if (dz > state.zone.radius * 0.8) {
      this.targetX = state.zone.cx;
      this.targetY = state.zone.cy;
      self.boost = dz > state.zone.radius * 0.95;
    }

    this.steerToward(self, this.targetX, this.targetY);
  }

  private steerToward(self: Player, x: number, y: number) {
    self.targetAngle = Math.atan2(y - self.headY, x - self.headX);
  }
}
