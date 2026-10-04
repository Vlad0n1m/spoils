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

## On-chain

SPOILS writes its game results to Solana through its own Anchor program, `spoils_events` (`programs/`, Anchor 0.32).

| | |
|---|---|
| Program id | `8Jc6sbbLY7PoJ2wms33k9MzYmMBdidH96vX4nLFbqf9B` — [Solana Explorer (devnet)](https://explorer.solana.com/address/8Jc6sbbLY7PoJ2wms33k9MzYmMBdidH96vX4nLFbqf9B?cluster=devnet) |
| Config PDA (seed `config`) | `4K8fSU19yNccXzNuUBPWyx6EXdnBrJgndnfjt3rfcgjY` |
| Record signer (server authority) | `AHgxhkN5Qu9T9nuV5yBaSU2oR6Xk7XA1QkrYRcUiPgNN` |
| Deploy key (payer, upgrade authority) | `CeJN65LnHmCn6wZ9xPcFsLWenLjkjpUKoZ7LTKiE8cah` |
| Status (2026-10-04) | Built, Rust and web tests pass. The devnet deploy waits for test SOL on the deploy key (the faucet's daily limit was hit); `programs/scripts/deploy-devnet.sh` then deploys, initializes and sends sample transactions, which `/economy` lists with explorer links |

What is recorded. Each record is one instruction that checks the signer, bumps a counter in the Config and emits an
event into the transaction log. No account is created per event, so there is no rent, only the transaction fee:

| Instruction | When | Data on chain |
|---|---|---|
| `record_match` | a world map (one shard of a 45-minute cycle) is settled by `raids/end` | `cycle_id`, `shard`, `match_hash` = sha256 of the canonical end report (keys sorted), `humans`, `mia` |
| `record_boss_kill` | the event boss dies (`world/event`) | `cycle_id`, `boss_kind` (index in `BOSS_KINDS`), `killer_hash` |
| `record_rare_extract` | a registered raider brings out an epic or legendary unique they did not bring in, or epic+ junk (one per item type per exit) | `cycle_id`, `item_def_hash` = sha256(def id), `rarity`, `owner_hash` |

Only live world shards are recorded (no demo shards, no guests' finds). Admin instructions: `initialize` (only the
upgrade authority, so nobody can claim the Config after the deploy) and `set_authority` (the current signer or the
upgrade authority).

Why players never pay: the server authority is the only signer and the fee payer of every record. Players do not
need a wallet for it and never see a transaction. Privacy: no account ids, nicknames or emails go on chain.
`owner_hash` = sha256(`CHAIN_HASH_SALT` + `":user:"` + userId); `killer_hash` = sha256(`CHAIN_HASH_SALT` +
`":boss_kill:user:"` + userId), or `":boss_kill:guest:"` + nickname for a guest killer, and 32 zero bytes when no raider
killed the boss. The two hashes of one player differ on purpose: the lobby names every boss killer, and a shared hash
would tie that nickname to the player's rare extracts. A boss kill counts for a registered player only when the game
server reports their user id and they hold a registered entry in that very shard (a guest cannot borrow a registered
nickname). The salt stays on the server, so a hash cannot be tested against a known id.

How it flows: settlement inserts a row into `chain_events` inside its own database transaction, in a savepoint, so a
failure there never breaks a raid. The `cron` service calls `/api/cron/chain-events` every minute (Bearer `CRON_SECRET`).
Each call first checks that the program is deployed, the Config names this signer and the signer can pay a batch of
fees on top of its rent-exempt minimum (0.00089 SOL), then sends up to 10 due events signed with
`CHAIN_AUTHORITY_SECRET` and waits for confirmation. A dead RPC, a lagging node, a missing key or any of those checks
failing only leaves events queued; send errors back off from 30 s, doubling up to 30 min. If the cluster still refuses
the fee payer, the event goes back uncounted and the pass stops. Only a program rejection counts toward failing an
event: the fifth one marks it failed (/economy shows "not recorded"), and
`DATABASE_URL=… apps/game-server/node_modules/.bin/tsx programs/scripts/chain-admin.ts requeue-failed [id …]` puts failed
events back (in Docker: `update chain_events set status='queued', attempts=0, rejections=0, next_at=now() where
status='failed';` in psql). The signature is stored before sending, so a retry checks whether the earlier transaction
landed instead of recording the event twice. The signer key is read only from `CHAIN_AUTHORITY_SECRET`, in dev too:
there is no key-file fallback, so a dev machine never signs with the production key by itself. Code: `apps/web/src/lib/chain`, table `chain_events` (migration
`apps/web/migrations/004_chain_events.sql` for an existing database). Env names: `.env.example`, block "On-chain game
results".

```bash
cd programs
nice -n 10 env CARGO_BUILD_JOBS=4 anchor build   # target/deploy/spoils_events.so + target/idl (copy to programs/idl/)
cargo test -p spoils-events                       # Rust unit tests
scripts/deploy-devnet.sh                          # deploy + init + fund the signer + 3 sample events + status
cd .. && apps/game-server/node_modules/.bin/tsx programs/scripts/chain-admin.ts status
apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/chain/queue.test.ts   # one file at a time
```

Keypairs live in `programs/.keys/` (gitignored: `deploy.json`, `authority.json`, `program.json`); the build output
`programs/target/` is ignored too. Every command passes an explicit devnet URL and keypair, because the machine's
global Solana CLI config may point at mainnet.

Что сделать Владу:

1. Пополнить `CeJN65LnHmCn6wZ9xPcFsLWenLjkjpUKoZ7LTKiE8cah` на ~3 devnet SOL через https://faucet.solana.com
   (лимит airdrop по IP 04.10 исчерпан) и запустить `programs/scripts/deploy-devnet.sh`.
2. В `.env` сервера: `CHAIN_AUTHORITY_SECRET` (содержимое `programs/.keys/authority.json`) и `CHAIN_HASH_SALT`
   (например, `openssl rand -hex 32`; не менять после запуска). На существующей базе применить `004_chain_events.sql`.
3. Сохранить `programs/.keys/` в менеджере паролей и офлайн-бэкапе: без `deploy.json` программу не обновить.

## Deploy

### Single VPS with docker compose

`docker-compose.yml` runs everything on one host:

| Service | What it does |
|---|---|
| `postgres` | Postgres 16, data in the `extract_postgres_data` volume, not published to the host |
| `migrate` | One-shot `drizzle-kit push` of the schema, then exits |
| `web` | Next.js standalone server on `127.0.0.1:3000`. Before `server.js` it runs `deploy/web-preflight.mjs`: in production it refuses to start without `CRON_SECRET` (16+ chars), `DATABASE_URL`, `SESSION_SECRET` or `GAME_SERVER_HMAC_SECRET` |
| `game-server` | Colyseus on `127.0.0.1:2567`, one always-live world. Refuses to boot in production without `GAME_SERVER_ID`, `WEB_API_BASE_URL` or `GAME_SERVER_HMAC_SECRET` |
| `cron` | `deploy/cron/scheduler.mjs` (plain Node, no deps) calls the web cron routes with `Authorization: Bearer $CRON_SECRET`, like Vercel Cron does: `void-raids` every 5 min (and once at start), `watch-deposits` every 10 min (a no-op while deposits are disabled), `economy-daily` at 00:05 UTC, `chain-events` every minute, `replays-retention` at 03:30 UTC (admin replays older than 14 days). Schedule: `deploy/cron/schedule.json` |

```bash
cp .env.example .env        # fill it: see the list below; never commit it
docker compose config -q    # validate
docker compose up -d --build
docker compose logs -f web game-server cron
```

- TLS and the public entry: `deploy/nginx/spoils.conf` (`SPOILS_DOMAIN` → web, `game.SPOILS_DOMAIN` → game server
  WebSocket). Build the web with `NEXT_PUBLIC_GAME_SERVER_URL=wss://game.SPOILS_DOMAIN`: `NEXT_PUBLIC_*` values are baked
  in at build time, so rebuild the `web` image after changing them. Install `deploy/nginx/catch-all.conf` once per host
  (unknown Host names never reach the web) and set `SIWS_ALLOWED_HOSTS=SPOILS_DOMAIN` (wallet linking signs in to that
  domain only; unset, it works on localhost only).
- An existing database from before World v6: apply `apps/web/migrations/002_world_v6.sql` (idempotent) first, then the
  `migrate` service pushes the rest.
- An existing database outside docker (staging, production): apply every migration newer than the database, in order,
  BEFORE the new web build goes live. All are idempotent (safe to re-run):

  ```bash
  for f in 005_friends_party 006_admin_role 007_replays 008_quests 009_replay_gen_version; do
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "apps/web/migrations/$f.sql"
  done
  ```

  006 and 008 add `users` columns (`role`; `title`, `name_color`, `badge_frame`) that every query reading whole `users`
  rows selects (login, `/api/me`, stash): without them those routes answer 500. Without 007 every replay chunk from the
  game server is refused with a 500 (the game server keeps 10 minutes of chunks, then drops them); 009 adds
  `replays.gen_version`.
- Ship the web and the game server together. The map generator is at `MAP_GEN_VERSION` 4 (map v2, mapHash `dda13fd8`):
  while only one side is updated every join is refused with `map_mismatch`. The web goes live first or at the same
  time: the game server records replays in format 2 (Weapons v2 weapon codes), which an older web refuses, and the new
  client needs the new server for grenades (`C2S.THROW`, sound kinds 14 and 15).
- Game server env: `REPLAY_RECORD=0` turns the admin replay recording off (on by default whenever `WEB_API_BASE_URL` is
  set). The game server does not read `.env` in compose: it gets an explicit list of variables (`environment:` in
  `docker-compose.yml`, interpolated from `.env`), so a new game-server variable must be added there. It is not on the
  `db` network and never sees the wallet keys, `SESSION_SECRET`, `CRON_SECRET` or the database password.
- Secrets (docs/SECURITY_AUDIT.md, Russian): `chmod 600 .env`; set `POSTGRES_PASSWORD` (unset → `postgres`, the
  preflight warns); `SESSION_SECRET` of 32+ characters (`openssl rand -hex 32`; production refuses a shorter one);
  `NEXT_PUBLIC_WALLET_DEV_TOPUP=0` (production refuses it unless `WALLET_DEV_TOPUP_PRODUCTION=1` on a devnet demo).
  Behind a CDN, enable the `set_real_ip_from` block of the nginx sample, or every player shares one auth throttle bucket.
- Routes added since World v6 (all JSON):

  | Route | Who |
  |---|---|
  | `GET /api/friends`, `POST /api/friends/{request,accept,decline,cancel,remove}` | registered players |
  | `GET /api/party` (menu poll + presence), `POST /api/party/{invite,uninvite,accept,decline,leave,kick,disband,lead,follow}` | registered players |
  | `GET /api/quests`, `POST /api/quests/reroll`, `POST /api/quests/equip` | registered players |
  | `GET /api/quests/badges?n=…` | public, cached 30 s |
  | `POST /api/admin/replays/ingest` | the game server (HMAC) |
  | `GET /api/admin/replays`, `GET /api/admin/replays/:matchId`, `GET /api/admin/replays/:matchId/chunks?from&to`, `/api/admin/**` | admins only (404 otherwise) |
  | `GET /api/cron/replays-retention` | cron (Bearer `CRON_SECRET`), daily 03:30 UTC |
- Order: the web first, then the game server. Restart the game server right after a wipe (a minute past 00:00,
  00:45, 01:30… UTC): a restart in the middle of a map voids it, gear goes back to its owners, and the server opens
  a fresh copy of the current map.
- Without docker: `pnpm build`, export the `.env` values, run the web with `NODE_ENV=production node deploy/web-preflight.mjs && pnpm --filter web start`,
  the game server with `pnpm --filter game-server start`, and call the cron routes from the host crontab with the same
  Bearer header (see `deploy/cron/schedule.json`). On Vercel the crons come from `apps/web/vercel.json` and Vercel sets
  `CRON_SECRET` itself.

### Android app (TWA, WebView shell)

Two wrappers, same web game:

- **TWA (Bubblewrap), `twa/` — primary** (owner's choice). Instructions below.
- **WebView shell (`solana-mobile webshell`), `webshell/` — use when the wallet must work inside the APK.**
  Solana Mobile's docs (checked 2026-10-04) warn that Chrome's Local Network Access restrictions break Mobile Wallet
  Adapter connections in TWA wrappers such as Bubblewrap; the shell hands wallet intents to the wallet app natively
  and needs no Digital Asset Links. The web already uses `@solana-mobile/wallet-standard-mobile` 0.6.0 (≥ 0.5.1
  detects the shell). Commands: [`webshell/README.md`](webshell/README.md) — `webshell init` with
  `webshell/web-manifest.json`, `webshell/patch-android.sh` (landscape, no pull-to-refresh, immersive), `webshell
  build`. With the same package id and upload key as the TWA it installs as an update over it.

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
address bar. The icons `/icon-512.png` and `/icon-512-maskable.png` (the character inside the central 80% on the
`#08070B` background, also listed in `manifest.webmanifest` as `purpose: maskable`) are served from `apps/web/public`.
The web manifest, the page theme colour, the TWA and the webshell all use `#08070B`.

### Что вписывает Влад

Только имена — значения в `.env` на сервере и в менеджере паролей, в репозиторий не попадают.

- Домен: `SPOILS_DOMAIN` в `deploy/nginx/spoils.conf` и `twa/twa-manifest.json`, `NEXT_PUBLIC_GAME_SERVER_URL` (`wss://game.<домен>`), `NEXT_PUBLIC_SITE_URL` (`https://<домен>`, для превью ссылок; необязательно)
- `CRON_SECRET`
- `MASTER_SEED_HEX`
- `WORLD_SEED_SECRET`
- `GAME_SERVER_ID`
- `GAME_SERVER_HMAC_SECRET`
- `SESSION_SECRET`
- `SIWS_ALLOWED_HOSTS` — публичный домен игры (для издания iDos — его поддомен в `.env.idos.local`); без него привязка кошелька работает только на localhost
- `DATABASE_URL` (вне docker; в docker — `POSTGRES_PASSWORD`)
- Ключи Solana: `HOT_WALLET_SECRET_B58`, `SOLANA_RPC_URL`, `SOLANA_CLUSTER`, `NEXT_PUBLIC_SOLANA_RPC_URL`, `NEXT_PUBLIC_SOLANA_CLUSTER`
- Запись результатов в Solana (раздел On-chain): `CHAIN_AUTHORITY_SECRET` (содержимое `programs/.keys/authority.json`) и `CHAIN_HASH_SALT` (например, `openssl rand -hex 32`; после запуска не менять)
- Отпечаток SHA-256 ключа подписи в `apps/web/public/.well-known/assetlinks.json` (и `package_name`, если меняется `packageId`), путь к keystore в `twa/twa-manifest.json`

Секреты в репозиторий не кладутся: `.env` заполняется вручную.

### Админка

`/admin` — метрики альфы (онлайн, входы и исходы за 7 дней, CR по причинам, вещи по состояниям, доход казны, KPI
из `docs/ALPHA_PLAN.md` §4), стоп-краны экономики с подтверждением и журналом, место под просмотр повторов. Видна
только пользователю с `users.role = 'admin'`: гостю, игроку без роли и не вошедшему `/admin` и `/api/admin/**`
отвечают 404. Роль читается из базы на каждый запрос, поэтому выдача и снятие действуют сразу. Кнопки выдачи роли в
приложении нет — только SQL.

1. На существующей базе один раз применить миграцию (новая база получает всё через `pnpm db:push` / сервис `migrate`):
   `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/web/migrations/006_admin_role.sql`
2. Зарегистрироваться в игре обычным способом, затем выдать себе роль по нику:

   ```sql
   update users set role = 'admin' where nickname = 'ТВОЙ_НИК' returning id, nickname, role;
   ```

   В docker: `docker compose exec postgres psql -U postgres -d extract -c "update users set role = 'admin' where nickname = 'ТВОЙ_НИК' returning nickname, role;"`.
   Других значений, кроме `'admin'` и `NULL`, база не примет (опечатка `'Admin'` даст ошибку, а не тихий отказ).
3. Снять роль: `update users set role = null where nickname = 'НИК';`. Кто админ: `select nickname from users where role = 'admin';`
4. Журнал изменений стоп-кранов (он же на странице `/admin/params`):
   `select at, admin_nickname, target, old_value, new_value, note from admin_audit order by at desc limit 20;`

Стоп-краны — ключи `economy_params`, которые читает World v6: `autosell_mult` (в полосе регулятора 0.6–1.3; крон
`economy-daily` продолжает двигать его от нового значения), `pool_risk_k` (0–2; 0 — стоп выдачи пула входам, сумка
босса заполняется отдельно), `market_paused` (1 — рынок игроков не принимает лоты и не продаёт, ответ 503, снять свой
лот можно) и `kit_sale_paused` (1 — торгуемый стартовый набор не продаётся, бесплатный выдаётся). `pool_max_per_match`
показан только для чтения: World v6 его не читает. Денежные числа из админки не меняются.

Повторы: `/admin/replays` — список шард-циклов, открыть карту. Пробел — пуск/пауза, ←/→ — 5 с (Shift — 30 с), 1/2/3 —
скорость, F — следовать, 0 — вся карта, +/− — масштаб, Esc — снова все. Клик по точке — следовать за ней, клик по
событию — прыжок за 2 с до него. Если повтор записан на другом генераторе карты, сверху предупреждение (карта рисуется
текущим генератором). Повторы хранят userId и ник игроков с их перемещениями 14 дней и видны только админам.
