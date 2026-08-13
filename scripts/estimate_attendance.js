import { MODELS, runStructured } from './lib/anthropic.js';

const TOOL = {
  name: 'predict_attendance',
  description: '来場者数が未発表のイベントについて、類似イベントの実績等から来場者数の幅を予測する',
  input_schema: {
    type: 'object',
    properties: {
      min: { type: 'integer', description: '予測来場者数の下限' },
      max: { type: 'integer', description: '予測来場者数の上限' },
      basis: { type: 'string', description: '予測の根拠（参照した実績・会場規模等を日本語で簡潔に）' },
    },
    required: ['min', 'max', 'basis'],
  },
};

const SYSTEM = `あなたはペットイベントの来場者数を予測するアナリストです。
与えられた情報から来場者数の幅を保守的に（過大評価を避けて）予測してください。

## 確認済みの実績（これ以外に実績データは持っていません）

- わんにゃんドーム: Aichi Sky Expo（屋内展示場）、2日間、入場有料
  - 2026年: 2/21(土)8,066人・2/22(日)9,434人、計17,500人
  - 2025年: 2日間計18,872人

犬市場シリーズをはじめ、上記以外のイベントの来場者数実績は把握していません。

## 厳守事項

- **上記はわんにゃんドームの数字です。** 他のイベントの根拠として流用してはいけません。
  「岡崎開催時18,872人」のように、別シリーズの実績を対象イベントの実績であるかのように書くのは誤りです。
- 会場の性質で規模感は大きく変わります。屋内展示場の有料イベントの数字を、屋外や商業施設のイベントにそのまま当てはめないでください。
  - 屋内展示場・有料: 来場者は明確な目的を持って集まる。わんにゃんドーム級で2日間1.5〜2万人規模
  - 屋外の公園・河川敷・無料: 天候に大きく左右され、通りすがりの立ち寄りも含まれる。ブース数が同等でも屋内有料展示会と同規模とは限らず、数千人規模にとどまることも多い
  - 商業施設内: 施設の通常来客が流入するため単純比較が難しい。専有スペースは展示場より狭いことが多く、イベント目的の来場者はより少なくなりやすい
- ブース数が分かる場合は規模の手がかりに使ってよいですが、ブース数と来場者数は比例しません。
- 情報が乏しいときは狭い幅で断定せず、幅を広げてください（上限が下限の2倍程度になっても構いません）。
- basisには「どの会場種別・入場形態として判断したか」と「何を根拠にしたか」を必ず書いてください。
  確認できていない数値を実績であるかのように書かないこと。推定であることが分かる書き方にしてください。

根拠(basis)は日本語で1〜2文、簡潔に記載してください。`;

export async function estimateAttendance(event) {
  const days = countDays(event.start_date, event.end_date);
  const userContent = [
    `イベント名: ${event.name}`,
    `開催地: ${event.prefecture} ${event.venue}`,
    `開催期間: ${event.start_date} 〜 ${event.end_date}（${days}日間）`,
    `会場の性質: ${event.venue_type ?? 'その他・不明'}`,
    `入場料: ${event.admission ?? '不明'}`,
    `出展ブース数: ${event.booth_count ?? '不明'}`,
    `情報源: ${event.source_url}`,
  ].join('\n');

  // Haiku 4.5 は thinking 未指定で思考オフ。output_config.effort は
  // 受け付けずエラーになるため渡さない。
  return runStructured({
    model: MODELS.estimate,
    system: SYSTEM,
    userContent,
    tool: TOOL,
    maxTokens: 2048,
  });
}

/**
 * 開催日数（両端を含む）。タイムゾーンに依存しないようUTC上で計算する。
 */
function countDays(startDate, endDate) {
  const toUtc = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  const diff = Math.round((toUtc(endDate) - toUtc(startDate)) / 86400000);
  return Math.max(1, diff + 1);
}
