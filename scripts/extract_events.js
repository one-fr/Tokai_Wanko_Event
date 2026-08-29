import { MODELS, runStructured, webSearchTool } from './lib/anthropic.js';

const TOOL = {
  name: 'record_events',
  description: '検索結果・公式サイト本文から、東海4県で開催される犬メインのイベント情報を抽出して記録する',
  input_schema: {
    type: 'object',
    properties: {
      events: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'イベント名' },
            prefecture: {
              type: 'string',
              enum: ['愛知県', '岐阜県', '三重県', '静岡県', '東京都', '大阪府'],
              description:
                '東京都・大阪府はインターペット（東京・大阪）専用。それ以外のイベントで指定してはいけない',
            },
            venue: { type: 'string', description: '会場名' },
            address: { type: 'string', description: '会場住所（わかる範囲で。不明なら空文字）' },
            start_date: { type: 'string', description: 'YYYY-MM-DD形式の開催開始日' },
            end_date: {
              type: 'string',
              description: 'YYYY-MM-DD形式の開催終了日（単日開催ならstart_dateと同じ値）',
            },
            source_url: { type: 'string', description: '最も信頼できる情報源のURL' },
            venue_type: {
              type: 'string',
              enum: ['屋内展示場', '屋外の公園・河川敷', '商業施設', 'その他・不明'],
              description: '会場の性質。来場者数の規模感が大きく変わるため必ず判定する',
            },
            admission: {
              type: 'string',
              enum: ['有料', '無料', '不明'],
              description: '入場料の有無',
            },
            booth_count: {
              type: ['integer', 'null'],
              description: '出展ブース数。記載がなければnull（推測して埋めないこと）',
            },
            attendance_status: { type: 'string', enum: ['confirmed', 'unknown'] },
            attendance_value: {
              type: ['integer', 'null'],
              description:
                'attendance_statusがconfirmedの場合のみ、公式発表されている来場者数（合計）。不明ならnull',
            },
          },
          required: [
            'name',
            'prefecture',
            'venue',
            'start_date',
            'end_date',
            'source_url',
            'venue_type',
            'admission',
            'attendance_status',
          ],
        },
      },
      candidates: {
        type: 'array',
        description:
          '東海4県（およびインターペット）で見つけたイベントを、除外したものも含めて全件記録する。' +
          'events に採用したものもここに含めること。取りこぼしと意図的な除外を区別するための記録',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'イベント名' },
            date: {
              type: 'string',
              description: '開催開始日。YYYY-MM-DD が分からなければ情報源の表記のまま',
            },
            source_url: { type: 'string', description: 'このイベントを見つけた情報源のURL' },
            included: { type: 'boolean', description: 'events に採用したかどうか' },
            reason: {
              type: 'string',
              description: 'included が false の場合の除外理由。採用した場合は空文字',
            },
          },
          required: ['name', 'included'],
        },
      },
    },
    required: ['events', 'candidates'],
  },
};

// 1回の実行で収集を目指すイベント件数。月1回実行のため取りこぼしを避けて広めに探す。
// あくまで目標であり、基準を満たさないイベントを件数合わせで含めさせないこと。
const TARGET_EVENTS = 20;

// web_search の実行回数上限。目標件数を満たすには4県ぶんの検索が要るため多めに確保する。
const MAX_SEARCHES = 25;

/**
 * 収集対象期間に含まれる年月を「2026年9月」形式で列挙する。
 * 検索クエリに年だけを付けると終了済みイベントの記事が大量に引っかかるため、
 * 月単位で検索させる材料としてプロンプトへ渡す。
 */
function monthRange(today, horizon) {
  let [y, m] = today.split('-').map(Number);
  const [hy, hm] = horizon.split('-').map(Number);
  const out = [];
  while (y < hy || (y === hy && m <= hm)) {
    out.push(`${y}年${m}月`);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

function buildSystem({ today, horizon }) {
  const months = monthRange(today, horizon);
  return `あなたは東海4県（愛知・岐阜・三重・静岡）の犬関連イベント情報を収集するアシスタントです。

本日は ${today} です。抽出対象は ${today} 〜 ${horizon}（6ヶ月先）に開催されるイベントに限ります。

手順（この順序で行うこと）:
1. web_search ツールで東海4県の犬イベント情報を検索する。与えられた公式サイト本文だけでは新規イベントを発見できないため、検索は必ず行うこと
2. **除外の判断をする前に**、見つかったイベントを candidates として全件洗い出す。
   複数の都道府県のイベントが並ぶ集約ページ・まとめ記事では、**東海4県のものを1件ずつ拾い漏らさないこと**。
   「開催日：YYYY/MM/DD」形式で列挙されたリストは、上から順に最後まで確認する。
   この段階では除外基準を適用せず、東海4県で開催される犬関連イベントは疑わしいものも含めてすべて挙げる
3. candidates の1件ずつに厳守事項を適用し、基準を満たすものだけを events に入れる。
   除外したものは candidates 側で included=false とし、reason に理由を書く
4. record_events ツールで candidates と events の両方を記録する

candidates は events を含む上位集合になる。events にあって candidates に無い、という状態は誤り。

## 目標件数

**${TARGET_EVENTS}件程度**の収集を目標とします。この実行は月に1度しか行われないため、取りこぼしを避けて網羅的に探してください。

ただし**件数合わせを優先してはいけません**。下記の厳守事項を満たさないイベントを件数のために含めることは、目標未達より悪い結果です。基準を満たすものが${TARGET_EVENTS}件に届かなければ、届いた分だけを返してください。

検索の指針:
- **web_search は「未知のイベントの発見」に使うこと。**
  添付する情報源には公式サイトとイベントまとめサイトが含まれており、そこに載っているイベントは
  検索しなくても取得できている。**まず添付本文を最後まで読み切り**、そこに無いイベントを探すために検索を使う
- **検索クエリには対象の「年月」を含めること。** 年だけを付けると、終了済みイベントの記事が大量に
  引っかかり検索回数を浪費する（実測では検索25回のうち多くが過去イベントの掘り起こしに費やされた）。
  対象月は次のとおり: ${months.join('・')}
  「2026年10月 犬 イベント 愛知」のように、月と県を組み合わせて検索する
- **「インターペット」は毎回必ず検索すること**（東京・大阪の両方）。
  公式サイト本文を添付しているが、開催日が変更されていないか検索でも裏取りする
- 4県すべて（愛知・岐阜・三重・静岡）を個別に検索し、特定の県に偏らないようにする
- 県名や地域名（東海／愛知／岐阜／三重／静岡／名古屋／浜松／岐阜市／四日市 等）と
  「犬 イベント」「ドッグイベント」「犬 マルシェ」「ペットイベント」「わんこ イベント」を組み合わせる
- 年月を含めて検索する（${today.slice(0, 4)}年・${horizon.slice(0, 4)}年）
- 公式サイト本文で次回開催が未確定だったシリーズは、シリーズ名で個別に検索して最新の告知を確認する
- 大型商業施設・公園・ドッグラン・道の駅などの会場側の告知ページも探す
- 検索結果が薄い場合はクエリを変えて追加検索する

定期開催シリーズの扱い（取りこぼしが起きやすいので厳守）:
- 検索結果や集約サイトで見つけたイベントの日付が**過去のものだった場合、それだけで除外してはいけない**。
  犬イベントの多くは年数回の定期開催シリーズで、対象期間内に次回が予定されていることが多い
- 過去日付で見つけたシリーズは、**「イベント名 + 次回」「イベント名 + 対象月」で追加検索**し、
  対象期間内の開催回があるかを必ず確認する。会場が前回と変わっている場合もあるため、
  シリーズ名だけでなく最新の告知ページを確認すること
- 追加検索でも対象期間内の開催が確認できなかった場合に限り除外し、
  reason には「次回開催を検索したが対象期間内の開催を確認できず」と明記する
- 単に「見つけた日付が過去だから除外」という reason は認めない

会場・住所の扱い:
- 会場名と住所は、情報源に明記されているものだけを記載する。推測で補完してはいけない
- 公式サイト本文に「イベント概要」等の形で会場が明記されている場合は、それを最優先する。
  同じページ内に過去回の実施報告や御礼文が含まれ、別の会場名が出てくることがあるが、
  **今回の開催回の会場を取り違えないこと**
- シリーズものでも会場は回によって変わりうる。過去の開催実績から会場を推測せず、その回の告知を確認する
- 住所が確認できない場合は空文字にする。会場名から住所を推測して書かないこと

厳守事項:
- 開催が既に終了したイベント（終了日が${today}より前）は含めない。過去回の実績記事は次回開催日の根拠には使ってよいが、過去回そのものをイベントとして返してはいけない
- 開催日が${horizon}より先のイベントは含めない
- 「次回開催は未定」「詳細は後日発表」など具体的な開催日が確定していないものは含めない。年だけ・月だけしか分からないものも含めない
- 個人の散歩オフ会など小規模な集まりは対象外とする
- 開催地が東海4県以外のものは対象外とする。**ただし「インターペット」だけは例外**として、
  東京開催（東京ビッグサイト）・大阪開催（インテックス大阪）とも必ず対象に含める。
  この例外はインターペットに限られる。他の東京・大阪のイベントを含めてはいけない
- 開催日が不明確なもの、噂の域を出ないものは含めない
- 来場者数が本文中に明記されている場合のみ attendance_status を "confirmed" とし、その数値をattendance_valueに入れる。それ以外は "unknown" とする（このステップでは予測しない）
- 同一イベントが複数の情報源にまたがって出てきた場合は1件にまとめる。
  ただし**「同一イベント」とは開催日まで同じもの**を指す。
  **名前が同じでも開催日が違えば、それは同じシリーズの別の開催回であり、別々に記録すること。**
  情報源によって日付が食い違って見えても、安易に「表記ゆれ」と判断して1件に統合してはいけない。
  シリーズものは年に複数回開催されるのが普通で、統合するとその回が丸ごと失われる。
  例: 「木曽三川わんこマルシェ vol.28」(10/3-4・芝生広場北ゾーン) と
  「海津アクア×木曽三川わんこマルシェ 2026秋」(10/24-25・アクアワールド水郷パークセンター) は
  名前も会場も近いが**別の開催回**。実際に1件へ誤統合して10/3の回を取りこぼした
- 統合するかどうか迷った場合は、**統合せず別々に記録する**。
  重複は後段の名寄せで吸収できるが、取りこぼしは復旧できない
- 該当イベントが1件もない場合は空配列を返す`;
}

/**
 * 公式サイト本文を渡したうえでClaudeにWeb検索させ、構造化イベント情報の配列を得る。
 *
 * 検索はAnthropicのサーバー側ツール（web_search）で行うため、
 * クライアント側の検索実装や検索用APIキーは不要。
 *
 * @param {object} params
 * @param {string} params.today - YYYY-MM-DD
 * @param {string} params.horizon - YYYY-MM-DD（収集対象期間の終端）
 */
export async function extractEvents({ knownSourcePages, today, horizon }) {
  const userContent = [
    `${today} 時点で、${today} 〜 ${horizon} に東海4県で開催される犬イベントを調べて記録してください。`,
    `目標は${TARGET_EVENTS}件程度ですが、基準を満たさないものを件数合わせで含めないでください。`,
    '',
    '公式サイトとイベントまとめサイトの本文を以下に添付します。',
    'まずこれらを最後まで読み切って候補を洗い出し、そのうえで、ここに載っていない',
    'イベントを見つけるために web_search を実行してください。',
    '',
    '# 情報源の本文',
    ...knownSourcePages.map((p) => `## ${p.name} (${p.url})\n参考情報: ${p.notes}\n本文: ${p.text}`),
  ].join('\n');

  const { events, candidates } = await runStructured({
    model: MODELS.extract,
    system: buildSystem({ today, horizon }),
    userContent,
    tool: TOOL,
    serverTools: [webSearchTool({ maxUses: MAX_SEARCHES })],
    // Sonnet 5 は thinking 省略時も adaptive thinking が動く。max_tokens は
    // 「思考＋出力」の合計上限。目標20件ぶんの構造化出力に思考トークンが加わるため、
    // 10件で16000だった設定から引き上げておく。
    thinking: { type: 'adaptive' },
    effort: 'medium',
    maxTokens: 32000,
  });
  return { events, candidates: candidates ?? [] };
}
