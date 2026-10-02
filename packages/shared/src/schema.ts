import { Schema, type, MapSchema, ArraySchema } from "@colyseus/schema";

export class Segment extends Schema {
  @type("number") x = 0;
  @type("number") y = 0;
}

export class Player extends Schema {
  @type("string") sessionId = "";
  @type("string") userId = "";
  @type("string") nickname = "";
  @type("boolean") isBot = false;
  @type("number") headX = 0;
  @type("number") headY = 0;
  @type("number") angle = 0;
  @type("number") targetAngle = 0;
  @type("boolean") boost = false;
  @type("number") radius = 12;
  /** In-game mass (MASS_UNITS_PER_CENT units per staked US cent). */
  @type("string") massUnits = "0";
  @type([Segment]) body = new ArraySchema<Segment>();
  @type("number") extractStartedAt = 0;
  @type("number") extractedAt = 0;
  @type("number") exitOrder = 0;
  @type("boolean") alive = true;
  @type("number") diedAt = 0;
}

export class Orb extends Schema {
  @type("string") id = "";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("string") value = "0";
  @type("number") tier = 0;
}

export class Zone extends Schema {
  @type("number") cx = 0;
  @type("number") cy = 0;
  @type("number") radius = 0;
}

export class BattleState extends Schema {
  @type("string") matchId = "";
  /** Buy-in in US dollar cents. */
  @type("string") entryTierCents = "0";
  @type("string") phase = "lockin";
  @type("number") startedAt = 0;
  @type("number") clockMs = 0;
  @type("number") nextExitOrder = 1;
  @type({ map: Player }) players = new MapSchema<Player>();
  @type({ map: Orb }) orbs = new MapSchema<Orb>();
  @type(Zone) zone = new Zone();
}
