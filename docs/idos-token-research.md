# iDos: токен SPOILS ("Main") в экономике — что реально даёт платформа

Дата: 2026-10-05. Источники: скиллы iDos MCP (blockchain-system, currency-system, store-system, checkout-system, marketplace-system, item-system, title-system, cloud-code, quest-system, mailbox-system, reward-system, community-marketing-system), типы и код `@idosgames/core` 0.21.1 (`deploy/idos-shell/node_modules/@idosgames/core/dist/index.cjs`, `RealtimeSession-*.d.ts`), конфиг тайтла 8YECHSD4 (только чтение: get_currency, get_blockchain, get_store, get_marketplace, get_quest, get_mailbox, get_cloud_code).
**UNKNOWN** — в документации и типах не описано; проверять только на тестовой копии или спрашивать у iDos (Yerasyl).

## 0. Транспорт (как зовёт наш сервер)

- URL: `POST {base}/api/v2/{titleId}/Client/{Module}/{Action}/{userId}` (функция `E()` в SDK), заголовки `Authorization: Bearer <ClientSessionTicket>`, `X-IG-Platform`, тело JSON.
- Базовое тело (`buildAuthedBaseRequest`): `UserID`, `ClientSessionTicket`, `BuildKey`, `WebAppLink`, `RelatedEntityID` (uuid). Сервер iDos проверяет сессию на каждом действии (`ClientRun.Execute` → `ValidateUserSession`).
- Значит, всё ниже с тикетом игрока можно вызвать и с нашего сервера (как уже работает `User/GetUsageTime`). Отдельного серверного (admin/secret) API для игрового бэкенда в скиллах нет — **UNKNOWN**, существует ли такой API.

## 1. DonateToDeveloper / DonateToUsersPool

- Действия: `Blockchain/DonateToDeveloper`, `Blockchain/DonateToUsersPool`. SDK: `client.blockchain.donateToDeveloper(networkID, transactionHash)`.
- Запрос: `BlockchainRequest` = базовое тело + **`NetworkID`** (`"solana"`) + **`TransactionHash`**. Суммы в запросе нет.
- Это **отчёт об уже сделанном on-chain переводе**: игрок сам подписывает транзакцию в кошельке, мы сообщаем хэш, бэкенд проверяет её по цепочке. **Внутриигровой (кастодиальный) баланс не списывается**, и личного зачисления тоже нет («Donations never touch personal balances»).
- Ответ `DonationResponse`: `ServerTimeUtc`, `TransactionHash`, `NetworkID`, `CurrencyID`, `AmountNative` (сумма, прочитанная с цепочки, decimal-строка), `AmountUsd`, `Target` (`"Developer"` | `"UsersPool"`). То есть **сумму подтверждает сервер iDos**, по данным цепочки.
- Куда идут деньги: `Developer` — в долю разработчика (developer pool bucket); `UsersPool` — в пул `UsersWithdrawable` тайтла (из него платятся выводы игроков).
- Минимумы, комиссии, адрес, на который игрок должен отправить токены на Solana, защита от повторного хэша для донатов — **UNKNOWN**. Для депозитов повтор отклоняется строкой `"Transaction hash already used."`; для донатов это не описано. В нашем `get_blockchain` у сети `solana` нет полей `RewardPoolAddress` / `VaultDepositAddress`; скилл называет для Solana «platform pool» (`createPlatformPoolAdapter` в `@idosgames/wallet`, этот пакет у нас не установлен).
- Вывод: «заплатить SPOILS» через донат = подпись в кошельке на каждую оплату. Для серверного списания с внутриигрового баланса донат не подходит.

## 2. Ввод и вывод SPOILS, кастодиальность

- **Ввод (депозит)**: игрок переводит токены on-chain в пул платформы, затем `Blockchain/DepositToken` (`NetworkID`, `TransactionHash`). Сумма берётся из транзакции. Ответ `DepositTokenResponse`: `CurrencyID`, `AmountNative`, `AmountUsd`, `StateDelta.CryptoBalances[id].AmountDelta`. Ошибки: `"Transaction not found on chain."`, `"Transaction hash already used."`, нехватка подтверждений (у нас `RequiredConfirmations: 12`; для Solana скилл говорит, что вместо этого проверяется commitment).
- В типе `UserCryptoCurrencyState` есть `DepositAddresses: Record<NetworkID, {Address, Memo?, AssignedAt}>`, то есть возможны персональные адреса для депозита. Как они работают — **UNKNOWN**.
- **Купить SPOILS за фиат в iDos нельзя** (не описано). `IsPurchasable` есть только у виртуальных валют.
- **Вывод**: `Blockchain/RequestTokenWithdrawal` (`CurrencyID`, `NetworkID`, `WalletAddress`, `Amount` decimal-строкой, `Category` по умолчанию `"game_topup"`). Списание с баланса **сразу**; в ответ `SolanaSignature` (`Mint`, `WalletAddress`, `Amount`, `Nonce`, `ProgramID`, `SignatureHex`, `Ed25519PublicKey`, `Ed25519Message`), который игрок сам отправляет в цепочку. Потом `ConfirmWithdrawal(TitleTransactionID, OnChainTransactionHash)`. Если транзакция не прошла: `RetryWithdrawal` (пока статус `Pending`, `PendingWithdrawalTtlHours` = 24). После TTL статус `Abandoned`, и **деньги не возвращаются**.
- **Кастодиальность**: да. Баланс — запись в БД iDos (`InventoryV2.CryptoCurrencies.Main.Amount`), «server-authoritative». Он **не гарантирует выплату**: вывод упирается в пул `UsersWithdrawable` (пополняется депозитами и `DonateToUsersPool`, уменьшается выводами и **тратами крипты внутри игры — потраченное уходит в долю разработчика**). Если пул пуст: `"Title users-withdrawable limit reached…"`.
- Порядок проверок при выводе: флаги включения на всех уровнях → `MinWithdraw` (у нас 0) → баланс → безопасность аккаунта → KYC и лимиты → пул → комиссия.
  - Безопасность аккаунта (у нас): `MinAccountAgeDays: 7`, `MultiAccountCheckEnabled: true`, `BanOnSharedWithdrawalAddress: true`. Вывод на адрес, который уже использовал **другой** аккаунт этого тайтла для вывода или депозита, **сразу банит** аккаунт.
  - KYC и лимиты считаются в USD как `amount * ValueInUSD`. У нас `ValueInUSD: 0` и `Limits` не задан, поэтому эти проверки фактически выключены. Отдельного метода, чтобы пройти KYC, в SDK нет.
  - Комиссии: `DeveloperWithdrawalFeePercent` и `CommunityMarketingWithdrawalFeePercent` (у нас 0), плюс платформенная комиссия поверх (процент не раскрыт — **UNKNOWN**). Сжигание при выводе (`WithdrawalBurnPercent`) работает только на EVM; на Solana оно равно 0. Игрок получает `NetAmountNative`, а с баланса списывается `AmountNative` (gross).
- Из iframe idosgames.com игра не может работать с кошельком сама: функции кошелька возвращают `WALLET_USE_SITE_PANEL`, ввод и вывод идут через карточку кошелька сайта (`openPlatformWalletPanel()`). По прямой ссылке на игру ограничения нет.

## 3. Магазин за "Main"

- Да. Цена задаётся словарём `PriceOptions`; стоимость опции — `ResourceConsume` с записью `{Type:"CryptoCurrency", CurrencyID:"Main", Amount:<целое>}`. Поле `Amount` в `ResourceEntry` — целое (C# long). Нужен флаг `Permissions.SpendableInGame` (у нас `true`).
- Сейчас магазина нет: `get_store` вернул пустой ответ (`{"Success":true}` без Data). Купить можно только оффер, стоящий в **слоте** витрины.
- Покупка: `Store/Purchase`. `StoreRequest` = базовое тело + `OfferID`, `Count` (1–100), `SelectedOptionID`, `Payment` (только для реальных денег), `StoreID`/`SectionID`/`SlotID` (все три или ни одного), `RelatedEntityID` (SDK генерирует `store_buy_{offerID}_{userID}_{uuid}`; это ключ идемпотентности).
- Ответ `StorePurchaseResponse`: `ServerTimeUtc`, `OfferID`, `Count`, `Resources` (`ResourceOperation`: `Consume.Standard.Entries` — что списано, `Grant` — что выдано), `Inventory`. **Нового баланса в ответе нет**; доказательство списания — `Resources.Consume`. Свежий баланс читать отдельно (раздел 9).
- С сервера с тикетом игрока вызвать можно (транспорт тот же). Но покупка без участия клиента в скиллах не описана: это наш собственный выбор, а не сценарий iDos. Нужен оффер с наградой (`Reward.Grant` обязателен). Например, «технический» стекуемый предмет или виртуальная валюта, которую наш сервер потом проверяет и тратит.
- Если крипты не хватает: `client.checkout.requirementOf(option)` возвращает `shortfall`, и `@idosgames/wallet` докладывает недостающее с кошелька (депозит), затем покупка. На EVM это `payWithWalletEvm`; для Solana в скилле функция не названа — **UNKNOWN**.
- Потраченная в игре крипта уходит в **долю разработчика** и вычитается из пула, доступного игрокам на вывод (blockchain-system, data-model, пункт 6). Срабатывает квест-триггер `CryptoSpent`.

## 4. Выдача SPOILS игрокам (награды), IOU

- Флаги `CurrencyDefinitions` (у нас): `CryptoRewardsFromDeveloperShare: false`, `CryptoIouForScriptsAndAI: false`, `CryptoAutoRepayIouOnWithdrawal: true`. Main: `UnbackedRewardCurrencyID: "Main_IOU"`.
- Смысл по комментариям в типах:
  - crypto-награда покрывается из **пула наград игроков**;
  - если пула не хватает и `CryptoRewardsFromDeveloperShare=true`, недостающее берётся из доли разработчика, иначе **непокрытая часть выдаётся в `Main_IOU` 1:1**;
  - при тратах Main **сначала тратится IOU**;
  - `CryptoIouForScriptsAndAI=true` — награды из CloudCode и AI тоже получают IOU вместо отказа (по умолчанию выключено, то есть **отказ**);
  - `CryptoAutoRepayIouOnWithdrawal` — при выводе IOU гасится из пула наград игроков, «только недостающая часть».
  - Точная механика погашения — **UNKNOWN**.
- `Main_IOU` у нас: `IsTradable:false`, `IsPurchasable:false`, `IsRefundable:false`.
- `ServerGrantPolicy` в `CryptoCurrencyDefinition` (`Mode`, `FundingNetworkID`, `PerPlayerDailyTokens`, `TitleDailyTokens`) есть только в типах, без описания — **UNKNOWN**. Похоже на механизм серверной выдачи с дневными лимитами; спросить у iDos.
- Какие модули принимают `CryptoCurrency` в `Grant` (квесты, Reward-claims, сезоны), явно не задокументировано. Косвенно: тип `ResourceEntry` это допускает, есть триггер `CryptoEarned` с `Origin: "RewardClaim"`. Проверять на тестовой копии.
- Пути, по которым **наш сервер** может инициировать выдачу:
  - **CloudCode**: в API `server.*` **нет** вызова для выдачи валюты (есть `ReadUserData`, custom data, `HttpRequest`, `AddQuestProgress`, `SendMail`). Можно вызвать `server.AddQuestProgress(metricID, v)` для цели квеста с `Source:"ServerApi"`, а награду игрок забирает через `Quest/ClaimQuestReward`. Если в награде есть crypto, при пустом пуле и `CryptoIouForScriptsAndAI=false` выдача, видимо, будет отклонена — **UNKNOWN**. Вызвать CloudCode наш сервер может как `CloudCode/Execute` с тикетом игрока или через входящий webhook (`/api/v2/{titleID}/Public/CloudCode/Webhook/{id}`, HMAC). Сейчас CloudCode у тайтла не настроен.
  - **Почта**: **крипта запрещена** (`CRYPTO_FORBIDDEN`) — ни в письмах, ни в переводах.
  - **Бесплатный оффер магазина** с наградой в Main: только с лимитом (`TotalCap`/`DailyCap`/`CooldownSeconds`/`PerInstanceCap`). Работает как «кран», без серверной валидации заслуги — небезопасно.
  - **Reward `Claims` с `Mode:"Auto"`**: выдаются только сервером iDos; внешнего триггера не описано — **UNKNOWN**.
- Community Marketing: крипто-награды креаторам идут **напрямую из пула программы в кошелёк** (`withdrawCryptoReward`), минуя внутриигровой баланс. Скилл прямо пишет, что внутриигровой крипто-баланс «promises no payout».

## 5. Маркетплейс

- Сейчас выключен: `get_marketplace` пустой, по умолчанию `Enabled=false`.
- **Цена в крипте не поддерживается**: `MarketplacePricePolicy.Allowed[].Kind` — только `'Item' | 'VirtualCurrency' | 'EventToken'` (d.ts); флаги — `AllowVirtualCurrency`, `AllowItems`, `AllowEventTokens`. Виртуальная валюта в цене должна быть `IsTradable=true`. Main_IOU нетрадабелен.
- Товар — только предметы iDos (`InventoryV2`: стекуемые или экземпляры `UnstackableItems`) с `ItemDefinition.IsTradable=true`. Неэкипированные, не истёкшие; со «состоянием» — если разрешено `AllowUnstackableWithState`.
- Эскроу на создании, расчёт атомарный на обе стороны. Комиссия по умолчанию `Percent 0.05`, `Sink: "Burn"`: `fee = min(amount, max(ceil(amount*Percent), MinPerPosition))`.
- Зеркалить наши предметы в iDos: создать `ItemDefinition` в каталоге можно (конфиг). Но **выдать экземпляр игроку с нашего сервера нечем** — в CloudCode нет grant-API. Выдача только через модули iDos: магазин, лутбокс, крафт, квест-награда, депозит NFT. Двусторонняя синхронизация с нашим Postgres даёт две копии правды. Продать предмет за SPOILS напрямую на маркетплейсе всё равно нельзя.

## 6. Конвертация Main ↔ виртуальная валюта

- Действия `Currency/Convert` (только VC↔VC) и `Currency/CryptoConvert` (источник **обязательно Crypto**: crypto→VC или crypto→crypto). **VC→Crypto не поддерживается ни одним эндпоинтом** (`"Virtual→Crypto conversion is not supported."`).
- Условия: у источника `Conversion.Enabled`, цель есть в `Targets`, `Permissions.ConvertibleToVirtual` (у Main `true`). Курс `Manual` (`ConversionTarget.Rate`) или `Automatic` (`src.ValueInUSD / tgt.ValueInUSD`). `Fee` — доля (0.05 = 5%). Порядок: комиссия, затем курс, затем floor до целого для VC. Лимиты пары: `MinAmount`, `MaxAmount`, `DailyLimit`.
- **У Main сейчас нет блока `Conversion`**, `ValueInUSD: 0`. Значит, `CryptoConvert` откажет. Описание MCP говорит, что запись `Main` **защищена, изменения молча игнорируются**, поэтому включить конвертацию или задать `ValueInUSD`/`Limits`/`Decimals` для Main сами мы, вероятно, не можем — только через iDos (**проверить**).
- Ответ `CryptoConvertResponse`: `SourceSpent`, `FeeAmount`, `RateApplied`, `TargetCredited` (decimal-строки). Идемпотентность через `TransactionID` (ключ `CurrencyCryptoConvert:<key>`, хранится 7 дней).

## 7. Допуск по токенам (PlayAccess)

- Конфиг `Blockchain.PlayAccess`: `Mode` — `Open` (по умолчанию; у нас блока нет, значит Open) | `AnyWithLinkedWallet` | `WalletOnly`; `TokenGates[]`: `{Enabled, NetworkID, CurrencyID, MinBalance, BalanceSource: 'OnChain'|'InGame'|'Combined', DenyMessage}`.
- Это только «**держать** не меньше N». Платы за вход нет: баланс проверяется, но не списывается.
- Принуждение — на сервере iDos: при каждом логине и обновлении сессии (без подписи) и в `Blockchain/ConfirmPlayAccess` (`NetworkID?`). Без пропуска игровые вызовы получают HTTP 403 `PLAY_ACCESS_REQUIRED`; `Blockchain`, привязка аккаунта и `User`-чтения при логине остаются открыты. Логин при этом не падает.
- `Blockchain/GetPlayAccess` → `PlayAccessInfoResponse` (`Mode`, `TokenGates`, `LinkedWallets`, `Status: PlayAccessStatus {Granted, Error, WalletRequired, Balances[{CurrencyID, Balance, MinBalance}], GrantedUntil}`). Коды отказа: `PLAY_ACCESS_WALLET_REQUIRED`, `…_WALLET_NETWORK_NOT_GATED`, `…_GUEST_DISABLED`, `…_WALLET_LOGIN_ONLY`, `…_CHECK_FAILED` (RPC не прочитан, это не пустой кошелёк).
- Наш собственный бэкенд 403 iDos не видит: если гейт нужен и для наших эндпоинтов, читаем `GetPlayAccess` с тикетом и решаем сами. Дробный `MinBalance` плюс расхождение decimals (раздел 8) — риск для `OnChain`-проверки.

## 8. Decimals и единицы — риск

- `CryptoNetworkBinding.Decimals` в типах описан как «on-chain token decimals». У нас стоит `0`, а у mint `2jWPc…idos` на цепочке 6. Если бэкенд масштабирует депозиты и выводы по этому полю, то депозит 1 SPOILS (1 000 000 raw) может зачислиться как 1 000 000 единиц, а вывод N единиц — уйти как N raw (= N/10⁶ SPOILS). Поведение — **UNKNOWN**, но это первый кандидат на баг. Проверить одним маленьким депозитом и выводом на тестовой копии. Исправить может только iDos: Main защищён.
- Цены и награды в `ResourceEntry.Amount` — **целые**; внутриигровой баланс — decimal-строка. `checkout.cryptoShortfallOf` сравнивает их напрямую (`Number(Amount)`), значит единицы общие. Дробные SPOILS в цене магазина задать нельзя.
- `DisplayDecimals: 0`, `MinWithdraw: 0`, `ValueInUSD: 0`: USD-лимиты, KYC и курс `Automatic` не работают.
- Квест-скилл: если крипта хранится в минимальных единицах, у `CryptoSpent` ставить `ScaleWithRollMultiplier:false`.

## 9. Как наш бэкенд узнаёт баланс SPOILS

- `Blockchain/GetUserState` (тикет игрока) → `UserBlockchainStateResponse { State, CryptoBalances: { Main: { Amount, Frozen, DepositAddresses?, Compliance? } } }`. Также видны `LinkedWallets`, `PendingWithdrawals`, `Kyc`, `Stats`.
- `User/GetInventory` → `InventoryV2.CryptoCurrencies.Main.Amount` и `VirtualCurrencies.Main_IOU.Amount` (вероятно, там, т.к. IOU — виртуальная валюта).
- `Blockchain/GetTransactionHistory` (`Amount` = лимит, до 200) → `TokenTransactions[]` с `Direction`, `Status`, `Amount`, `TransactionHash`, `NetPayoutAmount` — для сверки.
- Push или webhook от iDos о смене баланса не описан — **UNKNOWN**; только опрос.

## Что это значит для экономики SPOILS

**A. SPOILS как «ключ», без списаний (самое простое и надёжное).**
PlayAccess `TokenGates` (`InGame` или `Combined`) и/или наш сервер читает баланс через `Blockchain/GetUserState` и открывает режимы, косметику, ранги. Деньги не двигаются, ledger iDos не нужен.
Доверие: верим ответу iDos про баланс на момент запроса. Минус: «одолжил токены → прошёл проверку → вернул».

**B. Оплата SPOILS через магазин iDos, исполнение у нас.**
Офферы в `Store` с ценой `CryptoCurrency/Main` и наградой в виде технического предмета-«квитанции» (или VC). Клиент покупает (`Store/Purchase`, при нехватке — довнос с кошелька). Наш сервер с тикетом читает `User/GetInventory`, «гасит» квитанцию (её нужно уметь тратить — через другой оффер или крафт, иначе квитанции копятся) и выдаёт предмет в нашем Postgres. Списание доказывает только ответ iDos (`Resources.Consume`) плюс сверка баланса. Потраченное уходит в долю разработчика.
Доверие: полностью кастодиально у iDos. Наш сервер доверяет API iDos и тикету; выплаты игрокам ограничены пулом `UsersWithdrawable`. Перед запуском обязательно закрыть вопрос Decimals 0 vs 6.

**C. Прямые on-chain платежи (донаты) как оплата.**
Игрок подписывает перевод в кошельке → `Blockchain/DonateToDeveloper` (или `DonateToUsersPool`, чтобы пополнить пул на вывод) → iDos возвращает `AmountNative` по данным цепочки → наш сервер проверяет хэш, сумму и отправителя сам (Solana RPC) и выдаёт товар. Повторное использование хэша блокируем у себя.
Доверие: минимально кастодиально, проверяемо по цепочке. Минусы: подпись на каждую оплату; в iframe idosgames.com кошелёк недоступен (только прямая ссылка или панель сайта); адрес и минимумы для Solana — UNKNOWN.

**Чего не сделать сейчас:**
- выдавать SPOILS с нашего сервера — нет grant-API; квест через `ServerApi` + claim возможен, но поведение crypto-награды без пула — UNKNOWN; почта запрещена;
- торговать предметами за SPOILS на маркетплейсе iDos;
- конвертировать VC→SPOILS;
- включить конвертацию Main→VC без iDos: Main защищён, нет `Conversion` и `ValueInUSD`.

**Вопросы к iDos (Yerasyl):**
1. Decimals 0 vs 6 у Main: как масштабируются депозиты и выводы, кто исправляет.
2. Смысл `ServerGrantPolicy`.
3. Можно ли задать `Conversion`, `ValueInUSD`, `Limits` у Main.
4. Адрес и минимум для депозита и доната на Solana; защита от повторного хэша у донатов.
5. Есть ли серверный (не клиентский) API для выдачи и списания.
