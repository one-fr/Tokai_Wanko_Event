// Google Custom Search JSON API（無料枠: 1日100クエリ）で東海4県の犬イベントを検索する固定クエリセット
const QUERIES = [
  '東海 犬 イベント',
  '愛知 犬 マルシェ',
  '岐阜 犬 イベント',
  '三重 犬 イベント',
  '静岡 犬 イベント',
  'わんにゃんドーム 次回',
  '犬市場 岡崎 次回',
  '名古屋 ドッグイベント',
  '愛知 ペットイベント',
];

export async function searchWeb() {
  const apiKey = process.env.GOOGLE_CSE_API_KEY;
  const cx = process.env.GOOGLE_CSE_CX;
  if (!apiKey || !cx) {
    throw new Error('環境変数 GOOGLE_CSE_API_KEY / GOOGLE_CSE_CX が設定されていません');
  }

  const results = [];
  for (const query of QUERIES) {
    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', apiKey);
    url.searchParams.set('cx', cx);
    url.searchParams.set('q', query);
    url.searchParams.set('num', '10');
    url.searchParams.set('gl', 'jp');
    url.searchParams.set('hl', 'ja');

    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[search_web] Custom Search APIエラー (query="${query}"): HTTP ${res.status}`);
      continue;
    }
    const data = await res.json();
    for (const item of data.items ?? []) {
      results.push({
        query,
        title: item.title,
        url: item.link,
        snippet: item.snippet,
      });
    }
    // 無料枠のレート制限に配慮し、クエリ間に軽くウェイトを入れる
    await sleep(300);
  }
  return results;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
