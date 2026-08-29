# 東海犬イベント自動収集システム 仕様書

実装（2026-08-29 時点）から起こした現行仕様。設計判断の経緯は [`plan.md`](./plan.md) を参照。

---

## 1. 概要

東海3県（愛知・岐阜・三重）で開催される犬関連イベントを月1回自動収集し、専用のGoogleカレンダーへ登録する。来場者数は公式発表があればその値を、無ければClaude APIによる予測値を「AI推定」と明記して備考欄に記載する。

| 項目 | 値 |
|---|---|
| 実行環境 | GitHub Actions（`ubuntu-latest`, Node.js 20, タイムアウト30分） |
| 実行頻度 | 毎月1日 9:00 JST（cron `0 0 1 * *`） |
| 収集対象地域 | 愛知県・岐阜県・三重県（例外としてインターペット東京・大阪） |
| 収集対象期間 | 実行日（JST）から6ヶ月先まで |
| 目標収集件数 | 1回あたり20件程度 |
| 必要なSecret | `ANTHROPIC_API_KEY` / `GOOGLE_SERVICE_ACCOUNT_KEY` / `GOOGLE_CALENDAR_ID` |

---

## 2. 処理フロー

```
1. 期間算出         today = todayJst(), horizon = today + 6ヶ月
2. 情報源の取得      fetchKnownSources({today, horizon})  ← HTTP直接取得
   + 状態読込        data/events.json
3. 検索・抽出        extractEvents()   ← Claude Sonnet 5 + web_search
4. 情報源の学習      updateDiscoveredSources()            ← DRY_RUNではスキップ
5. 期間フィルタ      isWithinRange() で機械的に再判定
6. 来場者数の確定    confirmed はそのまま / unknown は estimateAttendance()（Haiku 4.5）
7. カレンダー同期    syncCalendar()   ← 名寄せして insert / patch / skip
8. 状態の書き戻し    data/events.json 更新 → Actions がコミット＆push（最大5回リトライ）
```

`DRY_RUN=1`（または `true`）のとき、4・7の書き込みと8を行わず、抽出結果をJSONで標準出力する。Google Calendarクライアントを生成しないため `ANTHROPIC_API_KEY` のみで実行できる。

---

## 3. 収集対象の定義

### 3-1. 地域

`prefecture` は以下の enum に制限され、スキーマレベルで対象外の県を弾く。

```
愛知県 / 岐阜県 / 三重県 / 東京都 / 大阪府
```

東京都・大阪府は**インターペット専用**。他の東京・大阪のイベントは対象外。静岡県は2026-08-29に対象から除外した。

### 3-2. 期間

- `HORIZON_MONTHS = 6`（`run.js`）
- 判定式: `ev.end_date >= today && ev.start_date <= horizon`
- 開催中のイベント（開始済み・未終了）も対象に含む
- プロンプトでの指示に加え、`run.js` で機械的に再フィルタする**二重構造**

### 3-3. 基準日

`todayJst()` がJST基準の日付を返す。Actionsランナーは UTC で動くため、単純な `toISOString()` では実行日が1日ずれる。

---

## 4. 情報源

2系統を毎回HTTP直接取得する。検索に依存しない確実な経路。

### 4-1. `data/known_sources.json`（手で管理）

```json
{
  "series_id": "wandarake",
  "name": "wandarake marche（わんだらけマルシェ）",
  "official_url": "https://www.wandarake.buddys.life/",
  "notes": "..."
}
```

登録済み5件: `wannyandome` / `inuichiba` / `wandarake` / `interpets_tokyo` / `interpets_osaka`

### 4-2. `data/discovered_sources.json`（自動管理）

```json
{
  "url": "https://pettena.jp/blogs/pet-outings/dog-events-tokai",
  "hostname": "pettena.jp",
  "events_seen": 6,
  "first_seen": "2026-08-29",
  "last_hit": "2026-08-29",
  "misses": 0
}
```

**学習ルール**（`scripts/lib/sources.js`）

| 定数 | 値 | 意味 |
|---|---|---|
| `MIN_EVENTS_TO_LEARN` | 1 | 1件供給しただけで学習する |
| `MAX_DISCOVERED` | 12 | 保持上限（`events_seen` の多い順） |
| `MAX_PER_HOST` | 2 | 同一ホストからの保持上限 |
| `MAX_MISSES` | 3 | 連続不発での削除しきい値 |
| `QUICK_PRUNE_MISSES` | 1 | `events_seen <= 1` のまま不発なら即削除 |

- `known_sources.json` に登録済みのホストは学習しない（重複巡回の回避）
- ヒットしたURLは `events_seen` を加算し `misses` を0にリセット
- ヒットしなかったURLは `misses` を加算

### 4-3. 取得処理（`fetch_known_sources.js`）

- User-Agent: `tokai-dog-event-bot/1.0 (+https://www.one-fr.com)`
- リダイレクト追従、**20秒タイムアウト**
- 失敗しても警告のみ出して続行（1サイトの障害で実行全体を止めない）
- `htmlToText()` で `<script>` `<style>` とタグを除去
- `extractRelevant()` で **1ページ8000文字**（`TEXT_LIMIT`）に圧縮

**`extractRelevant()` の方式**

日付らしき記述の前後（-120 / +220文字）を窓として切り出し、**収集期間内の日付を含む窓を優先**して詰める。残り予算で期間外の窓も拾う。重なる窓は統合する。

年の記載がない日付（「10月3日」）は、収集期間の開始年・終了年を順に当てはめて期間内に収まる方を採用する。

> 先頭からの単純な打ち切りでは、ページ上部のナビゲーションで予算を使い切り後方が落ちる。日付周辺を集めるだけでも、日付が密なページでは窓が全体に融合して同じ結果になる。

---

## 5. 抽出（`extract_events.js`）

### 5-1. モデルと設定

| 項目 | 値 |
|---|---|
| モデル | `claude-sonnet-5` |
| thinking | `{ type: 'adaptive' }` |
| effort | `medium` |
| max_tokens | 32000（思考＋出力の合計上限） |
| サーバーツール | `web_search_20260209`（`max_uses: 25`, `user_location: JP/Asia/Tokyo`） |

`max_tokens` が 21,333（= 128000 × 10 ÷ 60）を超えると SDK が非ストリーミング要求を拒否するため、**ストリーミング（`messages.stream().finalMessage()`）で呼び出す**。

### 5-2. ツールスキーマ `record_events`

**`events[]`** — 採用したイベント

| フィールド | 型 | 必須 |
|---|---|---|
| `name` | string | ✓ |
| `prefecture` | enum（3県＋東京・大阪） | ✓ |
| `venue` | string | ✓ |
| `address` | string | |
| `start_date` / `end_date` | `YYYY-MM-DD` | ✓ |
| `source_url` | string | ✓ |
| `venue_type` | `屋内展示場` / `屋外の公園・河川敷` / `商業施設` / `その他・不明` | ✓ |
| `admission` | `有料` / `無料` / `不明` | ✓ |
| `booth_count` | integer \| null | |
| `attendance_status` | `confirmed` / `unknown` | ✓ |
| `attendance_value` | integer \| null | |

**`candidates[]`** — 見つけたイベントを除外分も含めて全件記録

| フィールド | 型 | 必須 |
|---|---|---|
| `name` | string | ✓ |
| `included` | boolean | ✓ |
| `date` | string | |
| `source_url` | string | |
| `reason` | string（除外理由） | |

`candidates` は `events` の上位集合。「列挙してから選別する」順序を出力構造として強制し、取りこぼしと意図的な除外をログで区別できるようにする狙い。

### 5-3. プロンプトの主要な制約

- **手順**: 検索 → 除外判断前に candidates を全件洗い出す → 基準を適用 → 記録
- **検索の役割**: 添付本文を読み切ったうえで、そこに無いイベントを探すために使う
- **検索クエリ**: 対象年月（`monthRange()` が「2026年10月」形式で生成）と県を組み合わせる
- **定期開催シリーズ**: 過去日付で見つけても除外せず、「イベント名＋次回」で追加検索する
- **会場・住所**: 情報源に明記されたもののみ。同一ページ内の過去回の記述と取り違えない
- **統合の判定**: 「同一イベント」とは**開催日まで同じもの**。名前が同じでも日付が違えば別の開催回として別々に記録する。迷った場合は統合しない
- **件数合わせの禁止**: 基準を満たさないイベントを目標件数のために含めない

---

## 6. 来場者数（`estimate_attendance.js`）

`attendance_status === 'confirmed'` かつ `attendance_value != null` ならその値を採用。それ以外はイベント1件ごとにClaudeで予測する。

| 項目 | 値 |
|---|---|
| モデル | `claude-haiku-4-5` |
| max_tokens | 2048 |
| thinking / effort | **渡さない**（Haiku 4.5 は `output_config.effort` でエラーになる） |

**入力**: イベント名 / 開催地 / 開催期間と日数 / 会場の性質 / 入場料 / ブース数 / 情報源

**出力**: `min` / `max` / `basis`（日本語1〜2文）

プロンプトが持つ実績データは**わんにゃんドームのみ**（2026年 計17,500人 / 2025年 計18,872人）。他シリーズへの流用を明示的に禁止し、会場種別ごとの規模感の違いを与えている。

---

## 7. カレンダー同期（`sync_calendar.js`）

### 7-1. 名寄せ `isSameEvent(a, b)`

判定順序:

1. `start_date` が不一致 → **別イベント**（ここは緩めない。同名シリーズの別開催回を統合しないため）
2. 双方に `series_id` があり一致 → **同一**
3. 名前（空白除去・小文字化）が部分一致 → **同一**
4. 名前のDice係数（文字バイグラム）が **0.4以上** → **同一**
5. 会場が部分一致 → **同一**
6. いずれも該当せず → 別イベント

実測値: 「犬祭りテラス」⇔「犬祭り in テラスゲート土岐」= 0.47、「デカケルわんこびより」⇔「海津アクア×木曽三川わんこマルシェ」= 0.10

### 7-2. 同期の判定

| 条件 | 動作 |
|---|---|
| 既存レコードなし、または `calendar_event_id` を持たない | `events.insert` |
| `attendance` が欠落している | `events.patch`（補完） |
| 予測 → 確定に変化 | `events.patch` |
| `end_date` または `venue` が変化 | `events.patch` |
| 上記いずれでもない | スキップ（`last_checked` のみ更新） |

### 7-3. 状態ファイルの整理

`RETENTION_DAYS = 365`。終了から365日を過ぎたレコードを `events.json` から除去する。**カレンダー側の予定は削除しない**。

### 7-4. カレンダーへの書式

```
summary : 【犬イベント】{name}
location: {address || venue}
start   : { date: start_date }
end     : { date: end_date + 1日 }   ← 終日イベントは exclusive end
description:
  【来場者数】約3,000〜8,000人（AI推定 / 根拠: ...）
  【ステータス】未発表（AI予測）
  【情報源】https://...
  【収集日】2026-08-29
```

確定値の場合は `【来場者数】17,500人（確定・公式発表）` / `【ステータス】確定（公式発表）`。

---

## 8. 状態ファイル `data/events.json`

```json
{
  "id": "犬市場-夜市-in-okazaki-2026-2026-08-14",
  "series_id": "inuichiba",
  "name": "犬市場 夜市 in OKAZAKI 2026",
  "prefecture": "愛知県",
  "venue": "岡崎城公園第6号 乙川河川緑地",
  "address": "愛知県岡崎市康生町521",
  "start_date": "2026-08-14",
  "end_date": "2026-08-15",
  "source_url": "https://...",
  "venue_type": "屋外の公園・河川敷",
  "admission": "有料",
  "booth_count": null,
  "attendance": {
    "status": "predicted",
    "min": 2000, "max": 5000,
    "basis": "...",
    "collected_at": "2026-08-14"
  },
  "calendar_event_id": "v3aqrr94q0bf09ep1iuiidbm6c",
  "last_checked": "2026-08-14"
}
```

- `id`: イベント名のスラグ ＋ `start_date`
- `series_id`: `guessSeriesId()` が名前から判定（`wannyandome` / `inuichiba` / `wandarake` / `interpets_tokyo` / `interpets_osaka` / `null`）
- `attendance.status`: `confirmed` なら `value`、`predicted` なら `min`/`max`/`basis`
- `manual_origin: true`: 手動作成した予定を追跡下に置いた場合に付与

> **注意**: 手動でカレンダーに追加した予定は `events.json` に登録しないと追跡されず、同じイベントを自動収集した際に重複する。`sync_calendar` は実際のカレンダーではなく `events.json` と突合する。

---

## 9. Claude API 呼び出し（`scripts/lib/anthropic.js`）

`runStructured()` が構造化出力を担う共通処理。

| 引数 | 説明 |
|---|---|
| `model` | `MODELS.extract` / `MODELS.estimate` |
| `tool` | 構造化データを受け取るツール定義 |
| `serverTools` | `web_search` 等（省略可） |
| `thinking` / `effort` | **渡されたときだけ**リクエストに載せる |

**制御ロジック**

- `serverTools` なし → `tool_choice` で対象ツールを強制、1往復で完了
- `serverTools` あり → `tool_choice: auto`。検索予算の残数を毎ターン `max_uses` に反映し、使い切ったら `tool_choice` で記録ツールを強制して打ち切る
- `stop_reason: 'pause_turn'` → 内容をそのまま返して再開
- `stop_reason: 'end_turn'` で記録ツール未呼び出し → 記録を促して再試行
- `stop_reason: 'refusal'` / `'max_tokens'` → エラーで停止
- 最大 `MAX_TURNS = 8` ターン
- ターンごとに検索回数と `stop_reason` をログ出力し、`max_uses` 超過時は警告

---

## 10. ログ出力

```
=== 東海犬イベント自動収集 開始 ===
収集対象期間: 2026-08-29 〜 2027-03-01
情報源取得: 9件（公式5 / 学習済み4） / 既存イベント: 21件
Claudeによる検索・抽出を実行中...
[web_search] turn0: 検索23回（累計23） / 要求=max_uses=25 / stop_reason=tool_use
[web_search] 検索実行: 合計23回
検出候補: 37件 / うち採用: 25件
除外された候補: 12件
  - {name} ({date}) ※{reason}
[情報源を学習] https://...（N件を供給）
[情報源を削除] https://...（N回連続でヒットなし、または上限超過）
学習済み情報源: N件
期間外として除外: N件
[新規登録] / [更新] / [スキップ] {name} ({start_date})
[整理] {cutoff} より前に終了したイベント N件 を events.json から除去
=== 完了: events.json を更新しました（合計N件） ===
```

---

## 11. コスト

| 項目 | 想定 | 月額 |
|---|---|---|
| GitHub Actions | 月1回・10〜20分 | $0（無料枠） |
| Google Calendar API | — | $0 |
| Web検索 | 最大25回 × 月1回（$10/1,000検索） | 約$0.25 |
| 抽出（Sonnet 5） | 入力10〜25万 / 出力1〜2万トークン | 約$0.45〜1.05 |
| 予測（Haiku 4.5） | 20件 × 入力約1,000 / 出力約300 | 約$0.05 |
| **合計** | | **約$0.7〜1.4** |

---

## 12. 既知の制約

- **`candidates` の `reason` は行動の証拠にならない。** 検索25回の実行で「次回開催を検索した」と18件が主張した実績があり、実行していない検索を実行したと書く場合がある
- **`max_uses` の超過が観測されている。** 上限8を指定した実行で17回、次の実行で13回。原因は未特定。ターンをまたぐ累計制御と超過警告のログで検知できるようにしてある
- **カレンダー登録と状態コミットは原子的ではない。** 間で失敗すると「カレンダーには登録済みだが `events.json` は未更新」となり、次回実行で重複登録される。pushリトライで発生確率を下げているのみ
- **手動でカレンダーに追加した予定は追跡されない。** `events.json` への登録が別途必要
- **GitHub は60日間リポジトリに活動がないとスケジュールを自動停止する。** イベントに変化がない月はコミットが発生しないため、2ヶ月続くと停止し得る
- **同一シリーズが同日に別会場で開催されると誤って統合される。** `series_id` 一致を同一判定に使っているため
