# SPOILS

An online PvP extraction shooter on Solana where the economy is built by players.
Play the alpha at **[spoils.gg](https://spoils.gg)**.

## Why this code is public

The source is public so that Colosseum judges and players can see that the game is real
and how it works. It is **source-available, not open source**: all rights are reserved.
You may read the code, but you may not copy, modify, redistribute, sell or host it.
See [LICENSE](LICENSE).

## Found a vulnerability? Report it and get rewarded

If you came here looking for holes in the game, we would rather pay you than fight you.
Report what you found privately and you will get a reward for valid findings,
decided case by case by how serious the issue is.

- Report privately via **[Security → Report a vulnerability](https://github.com/Vlad0n1m/spoils/security/advisories/new)**.
- Do not exploit the issue on the live game, do not publish it and do not use it to gain an
  advantage over other players.
- Give us reasonable time to fix it before you talk about it.

Exploiting a bug instead of reporting it hurts real players and their gear. Reporting it makes
the game better for everyone, including you.

Thank you, and see you on the map.

## Repository

| Folder | What it is |
|---|---|
| `apps/game-server` | Authoritative multiplayer server (Colyseus) |
| `apps/web` | Site, market, inventory and browser game client (Next.js, PixiJS) |
| `packages/shared` | Shared client-server contract |
| `programs/spoils-events` | Anchor program for on-chain game results (devnet) |
| `twa` | Android build for Solana Seeker |
| `scripts/econ` | Economy simulation |

Copyright (c) 2026 Vladislav Karachkov. All rights reserved.
