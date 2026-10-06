# CLOCK IN (Solana Mobile × Radiants): заявка SPOILS

Источник правил: https://solanamobile.radiant.nexus/ (проверено 2026-10-06).

## 1. Сроки

| Что | Когда |
|---|---|
| **Приём заявок закрывается** | **12.10.2026, 16:59 GMT+5** (11:59 UTC). Опозданий не принимают |
| Судейство | с 13.10, 05:00 GMT+5 |
| Итоги | 10.11.2026 |
| Публикация в dApp Store (только победителям) | в течение 30 дней после итогов, иначе приз не выплачивают |

Заявку можно править, пока она в черновике. После финального соглашения (final submission agreement) — нельзя.
Судят по коммитам GitHub **до дедлайна**.

## 2. Требования и наш статус

| Требование | Статус | Что сделать |
|---|---|---|
| Регистрация на Align (профиль строителя → Clock In Registration) | ❓ проверить | Влад: войти на Align, заполнить профиль, зарегистрироваться |
| Работающий Android APK | ✅ `dist-mobile/spoils-0.2.0.apk` (webshell, debug-подпись), установлен на Seeker, запуск проверен на эмуляторе API 34 | Проверить MWA на Seeker; release-ключ — только для dApp Store |
| Интеграция Solana Mobile Stack + Mobile Wallet Adapter | ✅ `@solana-mobile/wallet-standard-mobile` 0.6.0, `registerMwa`, Sign-In with Solana, подписи через MWA; Seed Vault на Seeker | Снять на видео подключение кошелька в APK |
| Осмысленное взаимодействие с Solana | ✅ devnet: SIWS-привязка кошелька, предметы как Metaplex Core assets, escrow-рынок `spoils_market` за SOL, запись результатов в `spoils_events` | В видео показать транзакцию + explorer |
| Mobile-first, не «PWA-обёртка» | ⚠️ главный риск оценки | См. раздел 4 |
| GitHub-репозиторий | ⚠️ `Vlad0n1m/spoils` (public) отстаёт: последний push 05.10 16:02, другая история (152 коммита против 208 локально), нет touch HUD v2, inventory v2, lobby v3 | Решение Влада: см. раздел 5 |
| Демо-видео ≈3 минуты, **на устройстве**, не в эмуляторе | ❌ нет | Сценарий в разделе 6, запись экрана Seeker |
| Pitch deck / короткая презентация | ❌ нет | Структура в разделе 7 |
| Проект начат ≤ 3 мес. до старта (08.09) | ✅ первый коммит 02.10.2026 | — |
| Без VC/angel-финансирования (для USDC) | ✅ (подтвердить в форме) | — |
| Одна заявка на участника | ✅ Colosseum разрешён параллельно (FAQ) | Не вступать в другие команды Clock In |
| Страна в списке разрешённых, KYC Sumsub для победителей | ❓ Влад проверяет список стран на сайте | — |

## 3. Тексты для формы (английский)

**Project name:** SPOILS

**Tagline (short):** A persistent PvP extraction shooter built for your thumbs — loot, fight, get out before the wipe, and own what you carry out on Solana.

**Category:** Mobile — Game

**Description:**

SPOILS is a cartoon top-down extraction shooter where one map is always live. Every 45 minutes the world wipes on a UTC clock (32 maps a day). You drop in whenever entry is open, loot containers, fight other players and NPC guards, and extract at least three minutes later. Anyone still on the map at the wipe goes missing in action and loses everything they carried. Every third map is a boss event.

Sessions are 3–10 minutes, which is what a phone wants: one raid on a coffee break, the next one at lunch, the wipe clock pulling you back.

Built for the phone:
- Landscape touch HUD designed for 740×360–1280×800: floating move stick, aim stick that fires past 55 % deflection, an icon cluster around the aim stick (roll, use, reload, grenade, swap), 44 px minimum hit areas, tap the minimap for the full map.
- Phone inventory: equipped column, pockets, scrolling backpack grid, tap-to-select item bar with Equip / Use / Drop; a clear "Bag full" flow.
- Orientation lock and a rotate-your-phone overlay that pauses the controls, immersive full screen, no pull-to-refresh, no page scroll anywhere in the menus.
- Haptics: distinct, throttled vibration patterns for hits, damage, kills, loot, extraction, low HP and the wipe warning (toggle in settings).
- Client-side shot prediction so fire feels instant on mobile networks. Measured on a Solana Seeker: 109 FPS, frame p95 16.6 ms, touch-to-frame 7 ms average.

On Solana (devnet):
- Mobile Wallet Adapter inside the APK: Sign-In with Solana links a self-custody wallet (Seed Vault on Seeker, Phantom, Solflare) to the account.
- Epic and legendary gear you extract can leave the game as Metaplex Core assets in your wallet.
- A player market: in-game credits for everyday trades, and SOL trades through our own escrow program (`spoils_market`).
- Seeker Genesis Token: the game reads the linked wallet's SGT on mainnet (Token-2022 group member of the SGT group) and gives Seeker owners a cosmetic Seeker badge in the lobby, party and leaderboards plus a one-time Seeker Genesis frame (one claim per SGT, no gameplay advantage).
- Match results, boss kills and rare extracts are written on chain by our Anchor program (`spoils_events`), with explorer links in the game.

**What is new during the hackathon:** the whole project. First commit 2 October 2026; the Android build, touch controls, phone HUD, phone inventory, MWA wallet link and on-chain items were all built during Clock In.

**Solana Mobile Stack / MWA integration:** `@solana-mobile/wallet-standard-mobile` registers MWA as a Wallet Standard wallet; the APK is built with the Solana Mobile `webshell` CLI so wallet intents go straight to the installed wallet app (MWA does not work inside Chrome-based TWA wrappers). Sign-In with Solana (single-use nonce, verified on the server), message and transaction signing through MWA.

**Tech stack:** TypeScript, Next.js 15, PixiJS, Colyseus 0.16 (authoritative 20 Hz server), Postgres/drizzle, Anchor 0.32 (Rust), Metaplex Core, Solana Mobile webshell (Android).

**Program addresses (devnet):**
- `spoils_events`: 8Jc6sbbLY7PoJ2wms33k9MzYmMBdidH96vX4nLFbqf9B
- `spoils_market`: 3eu7K4GkLw1CA74Z4JSadBjsxZHNpaauWTtky6u52eGB
- Core collection: GpKomKhahD93PDJB9jhz6v32Y8oMgVKcjrBWXu2kDBhX

**Links:** live web build https://spoils.gg/play · repo https://github.com/Vlad0n1m/spoils · APK: _(ссылка после загрузки)_ · video: _(ссылка)_ · deck: _(ссылка)_

**Team:** Vlad — solo builder (design, code, art direction), with AI agents.

**Funding:** no VC or angel funding.

## 4. Риск «PWA-обёртка» и как его закрыть

Правила прямо: прямые порты и PWA-обёртки с минимальной мобильной оптимизацией получат низкие баллы. Наш APK —
WebView-оболочка над веб-игрой, поэтому в заявке и видео надо доказать мобильную разработку:

1. В видео и деке — отдельный слайд/фрагмент «Built for the phone» с цифрами Seeker (109 FPS, 7 мс) и
   до/после из `docs/screens/mobile-hud-v2`, `inventory-v2`, `lobby-v3`, `mobile`.
2. Нативные возможности, которые стоит добавить до 12.10 (по убыванию пользы):
   - ✅ (коммит 684d602, ждёт деплоя) **Haptics** на попадание, получение урона, лут и выход (`navigator.vibrate` в WebView + разрешение VIBRATE).
   - ✅ (коммит 25b23d1, ждёт деплоя + миграция 018 + `SEEKER_RPC_URL`) **Seeker Genesis Token**: проверка владения через MWA → косметика/бейдж «Seeker» в лобби. Прямо бьёт в
     критерий «резонирует с сообществом Seeker».
   - **SKR** (отдельный приз $10k в SKR; стейкинг не считается): например, оплата стартового набора / лотов рынка в SKR
     или SKR-призы еженедельного лидерборда.
   - Push-напоминание о вайпе/боссе (возвращает игрока — критерий stickiness).
3. Все переходы и вход — без адресной строки, без выхода в браузер.

## 5. GitHub

Публичный `Vlad0n1m/spoils` создан 05.10 с отдельной историей (152 коммита). Локальный `main` — 208 коммитов,
remote не настроен. Судьи смотрят коммиты (техническая глубина), поэтому до 12.10 репозиторий должен содержать всё,
включая мобильные коммиты 06.10. Варианты (решает Влад): дозалить новые коммиты поверх публичной истории или заменить
историю локальной после проверки на секреты. Альтернатива из FAQ: приватный репозиторий через GitHub-приложение
Radiants Align.

## 6. Демо-видео (≈3:00, запись экрана Seeker)

| Время | Кадр | Текст за кадром |
|---|---|---|
| 0:00–0:15 | Иконка SPOILS на Seeker → запуск, лобби | One live map. It wipes every 45 minutes. Get in, get loot, get out. |
| 0:15–0:40 | Connect wallet → MWA → Seed Vault подтверждает Sign-In with Solana | Your Seeker wallet is your account, signed with Mobile Wallet Adapter. |
| 0:40–1:30 | Рейд: стики, стрельба, перекат, лут, полная карта по тапу, инвентарь | Built for thumbs: … |
| 1:30–1:55 | Выход через экстракт, отчёт рейда, опыт | Extract and keep everything. Stay past the wipe and lose it. |
| 1:55–2:30 | Эпический предмет → вывод в кошелёк (Core asset) → explorer; лот рынка за SOL | What you carry out, you own on Solana. |
| 2:30–2:50 | Таймер вайпа, босс-событие, лидерборды, пасс | Why you come back: … |
| 2:50–3:00 | Логотип, ссылки | SPOILS. Clock in, loot out. |

## 7. Pitch deck (8–10 слайдов)

1. SPOILS — логотип, слоган. 2. Проблема: мобильные web3-игры — кликеры и обёртки; хардкорных сессионных PvP на Seeker нет.
3. Игра за 30 секунд: живая карта, 45 минут, вайп. 4. Built for the phone (HUD, цифры Seeker). 5. Solana: MWA/SIWS, Core-предметы,
escrow-рынок, on-chain результаты (схема). 6. Почему возвращаются: вайп-часы, боссы, пасс, лидерборды, пати. 7. Что сделано за
хакатон (коммиты, скриншоты). 8. Дальше: dApp Store, mainnet, SKR/Genesis Token, сезоны. 9. Команда и ссылки.
