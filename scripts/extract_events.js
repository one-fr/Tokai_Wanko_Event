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
            prefecture: { type: 'string', enum: ['愛知県', '岐阜県', '三重県', '静岡県'] },
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
    },
    required: ['events'],
  },
};

function buildSystem({ today, horizon }) {
  return `あなたは東海4県（愛知・岐阜・三重・静岡）の犬関連イベント情報を収集するアシスタントです。

本日は ${today} です。抽出対象は ${today} 〜 ${horizon}（6ヶ月先）に開催されるイベントに限ります。

手順:
1. web_search ツールで東海4県の犬イベント情報を検索する。与えられた公式サイト本文だけでは新規イベントを発見できないため、検索は必ず行うこと
2. 検索結果と公式サイト本文を突き合わせ、実際に開催が確認できる「犬メイン、または犬猫混合でも犬の比重が大きいマルシェ・ドーム型イベント」を特定する
3. record_events ツールを呼び出して結果を記録する

検索の指針:
- 県名や地域名（東海／愛知／岐阜／三重／静岡／名古屋）と「犬 イベント」「ドッグイベント」「犬 マルシェ」「ペットイベント」を組み合わせる
- 年を含めて検索する（${today.slice(0, 4)}年・${horizon.slice(0, 4)}年）
- 公式サイト本文で次回開催が未確定だったシリーズは、シリーズ名で個別に検索して最新の告知を確認する
- 検索結果が薄い場合はクエリを変えて追加検索する

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
- 開催地が東海4県以外のものは対象外とする
- 開催日が不明確なもの、噂の域を出ないものは含めない
- 来場者数が本文中に明記されている場合のみ attendance_status を "confirmed" とし、その数値をattendance_valueに入れる。それ以外は "unknown" とする（このステップでは予測しない）
- 同一イベントが複数の情報源にまたがって出てきた場合は1件にまとめる
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
    '',
    '既知の主要シリーズについては、公式サイトの本文を以下に添付します。',
    'ただしこれだけでは新規イベントを発見できないため、必ずweb_searchも実行してください。',
    '',
    '# 公式サイト本文',
    ...knownSourcePages.map((p) => `## ${p.name} (${p.url})\n参考情報: ${p.notes}\n本文: ${p.text}`),
  ].join('\n');

  const { events } = await runStructured({
    model: MODELS.extract,
    system: buildSystem({ today, horizon }),
    userContent,
    tool: TOOL,
    serverTools: [webSearchTool({ maxUses: 10 })],
    // Sonnet 5 は thinking 省略時も adaptive thinking が動く。max_tokens は
    // 「思考＋出力」の合計上限なので、明示指定したうえで余裕を持たせる。
    thinking: { type: 'adaptive' },
    effort: 'medium',
    maxTokens: 16000,
  });
  return events;
}
