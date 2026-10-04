# SPOILS

Мультяшный extraction-шутер с видом сверху. Одна постоянно живая карта «The Outskirts» вайпается каждые
45 минут по часам UTC (00:00, 00:45, 01:30…, 32 карты в сутки). Игрок заходит в любой момент, пока открыт вход,
лутает, дерётся с игроками и NPC и выходит через 3 минуты после своего входа или позже. Кто остался на карте
к вайпу — MIA и теряет всё, что нёс. Каждая третья карта — событие с боссом. За действия дают опыт; есть уровни
и лидерборды.

Правила игры и экономики — `docs/GAME_DESIGN.md` (по-русски). План альфы — `docs/ALPHA_PLAN.md`.

## Устройство

pnpm-монорепо:

| Папка | Что это |
|---|---|
| `packages/shared` (`@extract/shared`) | Общий контракт: константы (`WORLD`, `MATCH`), экономика (`POOL`, `XP`, `BOSS_EVENT`), типы отчётов сервер → сайт, протокол, схема состояния Colyseus. Собирается в `dist`, его читают оба приложения и `scripts/econ` |
| `apps/game-server` | Colyseus 0.16, авторитарный сервер. `src/sim` — симуляция без Colyseus (матч, NPC, пул, уборка карты). `src/world` — `WorldDirectory`: открывает карту каждого цикла (новую — за 30 с до вайпа), вайпает, пускает игроков. `src/rooms` — комната `battle`, вход только `joinById` |
| `apps/web` | Next.js 15 + drizzle/Postgres: вход, склад, снаряжение, рынок, кошелёк, пул, расчёт выходов, опыт, лидерборды, главное меню `/play`. Клиент боя — PixiJS (`src/game`) |
| `scripts/econ` | Модель экономики на 90 дней (`econ-sim.mjs`) |
| `scripts/gen-*.mjs` | Генерация спрайтов и арта меню (gpt-image-2) |

Поток входа: `POST /api/world/join` (сайт блокирует снаряжение и подписывает билет с `matchId` и `entryId`) →
клиент `joinById(roomId, {ticket, mapHash})` → игровой сервер проверяет билет и спрашивает сайт `POST /api/raids/enter`
→ игрок на карте. Выход — `POST /api/raids/exit`, вайп — `POST /api/raids/end`, смерть босса — `POST /api/world/event`.
Все запросы сервер → сайт подписаны HMAC (`GAME_SERVER_HMAC_SECRET`). Лобби берёт статус мира из базы сайта
(`GET /api/world/status`), с игровым сервером напрямую не говорит.

## Запуск локально

Нужны Node 20+, pnpm 10, Postgres.

```bash
pnpm install
cp .env.example .env            # заполнить DATABASE_URL, SESSION_SECRET, GAME_SERVER_HMAC_SECRET и др.
createdb extract
pnpm db:push                    # новая база: схема целиком
# существующая база до World v6: сначала миграция, потом push
#   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/web/migrations/002_world_v6.sql && pnpm db:push
pnpm dev                        # shared в watch, сайт на :3001, игровой сервер
```

Без `WEB_API_BASE_URL` / `GAME_SERVER_HMAC_SECRET` вне production игровой сервер пускает всех с бесплатным набором
и ничего не рассчитывает — удобно для проверки боя без сайта.

Переменные World v6 (кроме тех, что в `.env.example`):

| Переменная | Где | Зачем |
|---|---|---|
| `GAME_SERVER_ID` | игровой сервер | Обязательна в production (без неё сервер не стартует). Стабильный id деплоя: после перезапуска сайт сразу возвращает вещи из карт старого процесса |
| `WORLD_SEED_SECRET` | игровой сервер | Необязательна, 32+ байта hex. Ключ расписания боссов; без неё выводится из `GAME_SERVER_HMAC_SECRET` |
| `WORLD_DEV_CLOCK_OFFSET_MS` | оба приложения | Только вне production: сдвиг часов мира, чтобы прыгнуть к закрытию входа или вайпу |

`GAME_SERVER_URL_BY_COUNTRY` должна оставаться пустой: мир один на один игровой сервер.

## Проверки

```bash
pnpm shared:build
pnpm typecheck
# тесты — по одному файлу, например:
apps/game-server/node_modules/.bin/tsx --test packages/shared/src/world.test.ts
apps/game-server/node_modules/.bin/tsx --test apps/game-server/src/sim/world.test.ts
```

Тесты сайта с базой используют `extract_test`. Бенчмарки и soak-тест (`apps/game-server/src/sim/econ`,
`sim/soak.test.ts`) тяжёлые — запускать на настольной машине, не на ноутбуке.

## Deploy

### Single VPS with docker compose

`docker-compose.yml` runs everything on one host:

| Service | What it does |
|---|---|
| `postgres` | Postgres 16, data in the `extract_postgres_data` volume, not published to the host |
| `migrate` | One-shot `drizzle-kit push` of the schema, then exits |
| `web` | Next.js standalone server on `127.0.0.1:3000`. Before `server.js` it runs `deploy/web-preflight.mjs`: in production it refuses to start without `CRON_SECRET` (16+ chars), `DATABASE_URL`, `SESSION_SECRET` or `GAME_SERVER_HMAC_SECRET` |
| `game-server` | Colyseus on `127.0.0.1:2567`, one always-live world. Refuses to boot in production without `GAME_SERVER_ID`, `WEB_API_BASE_URL` or `GAME_SERVER_HMAC_SECRET` |
| `cron` | `deploy/cron/scheduler.mjs` (plain Node, no deps) calls the web cron routes with `Authorization: Bearer $CRON_SECRET`, like Vercel Cron does: `void-raids` every 5 min (and once at start), `watch-deposits` every 10 min (a no-op while deposits are disabled), `economy-daily` at 00:05 UTC. Schedule: `deploy/cron/schedule.json` |

```bash
cp .env.example .env        # fill it: see the list below; never commit it
docker compose config -q    # validate
docker compose up -d --build
docker compose logs -f web game-server cron
```

- TLS and the public entry: `deploy/nginx/spoils.conf` (`SPOILS_DOMAIN` → web, `game.SPOILS_DOMAIN` → game server
  WebSocket). Build the web with `NEXT_PUBLIC_GAME_SERVER_URL=wss://game.SPOILS_DOMAIN`: `NEXT_PUBLIC_*` values are baked
  in at build time, so rebuild the `web` image after changing them.
- An existing database from before World v6: apply `apps/web/migrations/002_world_v6.sql` (idempotent) first, then the
  `migrate` service pushes the rest.
- Order: the web first, then the game server. Restart the game server right after a wipe (a minute past 00:00,
  00:45, 01:30… UTC): a restart in the middle of a map voids it, gear goes back to its owners, and the server opens
  a fresh copy of the current map.
- Without docker: `pnpm build`, export the `.env` values, run the web with `NODE_ENV=production node deploy/web-preflight.mjs && pnpm --filter web start`,
  the game server with `pnpm --filter game-server start`, and call the cron routes from the host crontab with the same
  Bearer header (see `deploy/cron/schedule.json`). On Vercel the crons come from `apps/web/vercel.json` and Vercel sets
  `CRON_SECRET` itself.

### Android app (Trusted Web Activity)

The mobile app is the web game wrapped by [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap) into an APK/AAB
(tested on a Solana Seeker). Config: `twa/twa-manifest.json` (package `app.spoils.twa`, landscape, fullscreen, start
URL `/play`). Everything Bubblewrap generates in `twa/` is git-ignored; only the manifest is versioned.

```bash
npm i -g @bubblewrap/cli
cd twa
# 1. Replace SPOILS_DOMAIN in twa-manifest.json and SPOILS_KEYSTORE_PATH with the keystore path.
# 2. First time only: create the upload key OUTSIDE the repo, e.g.
#    keytool -genkeypair -v -keystore ~/keys/spoils-upload.jks -alias spoils -keyalg RSA -keysize 2048 -validity 10000
bubblewrap update            # generates the Android project from twa-manifest.json
bubblewrap build             # asks for the keystore passwords → app-release-signed.apk + app-release-bundle.aab
bubblewrap fingerprint add <SHA-256>   # optional: keeps the fingerprint in twa-manifest.json
```

The keystore and its passwords never go into the repo (keep them in a password manager plus an offline backup;
losing the key means a new package on the store). Digital Asset Links: put the SHA-256 fingerprint of the signing key
(`keytool -list -v -keystore ~/keys/spoils-upload.jks -alias spoils`, or the Play App Signing key from the Play
Console) into `apps/web/public/.well-known/assetlinks.json` and deploy the web; without it the app shows a browser
address bar. The icons `/icon-512.png` and `/icon-512-maskable.png` must be served by the web.

### Что вписывает Влад

Только имена — значения в `.env` на сервере и в менеджере паролей, в репозиторий не попадают.

- Домен: `SPOILS_DOMAIN` в `deploy/nginx/spoils.conf` и `twa/twa-manifest.json`, `NEXT_PUBLIC_GAME_SERVER_URL` (`wss://game.<домен>`)
- `CRON_SECRET`
- `MASTER_SEED_HEX`
- `WORLD_SEED_SECRET`
- `GAME_SERVER_ID`
- `GAME_SERVER_HMAC_SECRET`
- `SESSION_SECRET`
- `DATABASE_URL` (вне docker; в docker — `POSTGRES_PASSWORD`)
- Ключи Solana: `HOT_WALLET_SECRET_B58`, `SOLANA_RPC_URL`, `SOLANA_CLUSTER`, `NEXT_PUBLIC_SOLANA_RPC_URL`, `NEXT_PUBLIC_SOLANA_CLUSTER`
- Отпечаток SHA-256 ключа подписи в `apps/web/public/.well-known/assetlinks.json` (и `package_name`, если меняется `packageId`), путь к keystore в `twa/twa-manifest.json`

Секреты в репозиторий не кладутся: `.env` заполняется вручную.
