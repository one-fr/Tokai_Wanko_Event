import { runStructured } from './lib/anthropic.js';

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
イベント名・会場・開催日数などの情報から、来場者数の幅を保守的に（過大評価を避けて）予測してください。

参考情報（東海地区の類似イベント実績）:
- わんにゃんドーム2025（Aichi Sky Expo、2日間）: 2/22(土)8,491人・2/23(日)10,381人、合計18,872人
- 犬市場 in OKAZAKI（岡崎公園乙川河川緑地、2日間、約150〜300ブース規模）

会場の収容規模・開催日数・ブース数などが分かればそれをもとに、分からなければ上記の参考実績と同程度の催事規模と仮定して幅を持たせて予測してください。
根拠(basis)は日本語で1〜2文、簡潔に記載してください。`;

export async function estimateAttendance(event) {
  const userContent = [
    `イベント名: ${event.name}`,
    `開催地: ${event.prefecture} ${event.venue}`,
    `開催期間: ${event.start_date} 〜 ${event.end_date}`,
    `情報源: ${event.source_url}`,
  ].join('\n');

  return runStructured({
    system: SYSTEM,
    userContent,
    tool: TOOL,
    maxTokens: 1024,
  });
}
