import { readFile } from 'node:fs/promises';

// 実行時のカレントディレクトリに依存しないよう、スクリプト位置を基準に解決する
const KNOWN_SOURCES_PATH = new URL('../data/known_sources.json', import.meta.url);

/**
 * known_sources.jsonに登録された公式サイトを直接取得し、本文テキストを返す。
 * 検索エンジン経由では拾いにくい「更新されたばかりの告知」を確実に拾うための経路。
 */
export async function fetchKnownSources(path = KNOWN_SOURCES_PATH) {
  const list = JSON.parse(await readFile(path, 'utf-8'));
  const pages = [];

  for (const source of list) {
    try {
      // 応答がないサイトで実行全体が止まらないようタイムアウトを設ける
      const res = await fetch(source.official_url, {
        headers: { 'User-Agent': 'tokai-dog-event-bot/1.0 (+https://www.one-fr.com)' },
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) {
        console.warn(`[fetch_known_sources] 取得失敗 (${source.series_id}): HTTP ${res.status}`);
        continue;
      }
      const html = await res.text();
      pages.push({
        series_id: source.series_id,
        name: source.name,
        url: source.official_url,
        notes: source.notes ?? '',
        text: htmlToText(html).slice(0, 8000), // トークン節約のため上限を設ける
      });
    } catch (err) {
      console.warn(`[fetch_known_sources] 取得エラー (${source.series_id}): ${err.message}`);
    }
  }
  return pages;
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
