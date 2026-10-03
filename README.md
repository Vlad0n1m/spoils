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

## Деплой

1. Применить `apps/web/migrations/002_world_v6.sql` (идемпотентна), затем `pnpm db:push`.
2. Сначала выложить сайт, потом игровой сервер.
3. На игровом сервере задать `GAME_SERVER_ID` и при желании `WORLD_SEED_SECRET`.
4. Игровой сервер выкладывать сразу после вайпа (минута после 00:00, 00:45, 01:30… UTC): перезапуск посреди карты
   отменяет её, вещи возвращаются владельцам, и сервер открывает новую копию текущей карты.

Секреты в репозиторий не кладутся: `.env` заполняется вручную.
