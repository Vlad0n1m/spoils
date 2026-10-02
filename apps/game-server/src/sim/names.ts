const BOT_NAMES = [
  "Rook", "Vex", "Moth", "Kestrel", "Juno", "Ash", "Grit", "Nomad",
  "Pike", "Wren", "Sable", "Dusk", "Flint", "Orca", "Hex", "Lynx",
  "Briar", "Cinder", "Talon", "Echo", "Rust", "Quill", "Sparrow", "Bolt",
];

/** Distinct bot nicknames, styled like player names so bots are not trivially spotted. */
export function botNames(count: number, rng: () => number = Math.random): string[] {
  const pool = [...BOT_NAMES];
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const base = pool.length ? pool.splice(Math.floor(rng() * pool.length), 1)[0]! : `Bot${i}`;
    out.push(`${base}${Math.floor(rng() * 90 + 10)}`);
  }
  return out;
}
