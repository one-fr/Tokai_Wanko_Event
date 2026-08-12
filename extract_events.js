import { runStructured } from './lib/anthropic.js';

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
            'attendance_status',
          ],
        },
      },
    },
    required: ['events'],
  },
};

const SYSTEM = `あなたは東海4県（愛知・岐阜・三重・静岡）の犬関連イベント情報を収集するアシスタントです。
与えられたWeb検索結果と公式サイト本文から、実際に開催が確認できる「犬メイン、または犬猫混合でも犬の比重が大きいマルシェ・ドーム型イベント」のみを抽出してください。

厳守事項:
- 個人の散歩オフ会など小規模な集まりは対象外とする
- 開催地が東海4県以外のものは対象外とする
- 開催日が不明確なもの、噂の域を出ないものは含めない
- 来場者数が本文中に明記されている場合のみ attendance_status を "confirmed" とし、その数値をattendance_valueに入れる。それ以外は "unknown" とする（このステップでは予測しない）
- 同一イベントが複数の情報源にまたがって出てきた場合は1件にまとめる
- 該当イベントが1件もない場合は空配列を返す`;

/**
 * 公式サイト本文とWeb検索結果をClaude APIに渡し、構造化イベント情報の配列を得る。
 */
export async function extractEvents({ knownSourcePages, searchResults }) {
  const userContent = [
    '# 公式サイト本文',
    ...knownSourcePages.map((p) => `## ${p.name} (${p.url})\n参考情報: ${p.notes}\n本文: ${p.text}`),
    '',
    '# Web検索結果',
    ...searchResults.map((r) => `- [${r.title}](${r.url})\n  ${r.snippet}`),
  ].join('\n');

  const { events } = await runStructured({
    system: SYSTEM,
    userContent,
    tool: TOOL,
    maxTokens: 8192,
  });
  return events;
}
