import { loadSources } from './lib/sources.js';

// 1ページから取り込む本文の上限。トークン消費を抑えるため。
const TEXT_LIMIT = 8000;

/**
 * 登録済みの情報源を直接取得し、本文テキストを返す。
 *
 * 対象は公式サイト（known_sources.json）と、実行結果から自動学習した
 * イベントまとめサイト（discovered_sources.json）の両方。
 * 検索に頼らず確実に取得できる経路で、web_searchの予算を未知イベントの発見に回すための仕組み。
 */
export async function fetchKnownSources(range = null) {
  const list = await loadSources();
  const pages = [];

  for (const source of list) {
    try {
      // 応答がないサイトで実行全体が止まらないようタイムアウトを設ける
      const res = await fetch(source.url, {
        headers: { 'User-Agent': 'tokai-dog-event-bot/1.0 (+https://www.one-fr.com)' },
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) {
        console.warn(`[fetch_known_sources] 取得失敗 (${source.name}): HTTP ${res.status}`);
        continue;
      }
      const html = await res.text();
      pages.push({
        series_id: source.series_id,
        kind: source.kind,
        name: source.name,
        url: source.url,
        notes: source.notes ?? '',
        text: extractRelevant(htmlToText(html), TEXT_LIMIT, range),
      });
    } catch (err) {
      console.warn(`[fetch_known_sources] 取得エラー (${source.name}): ${err.message}`);
    }
  }
  return pages;
}

/**
 * 上限を超える本文から、収集対象期間の開催日の周辺を優先して抜き出す。
 *
 * 先頭から機械的に切ると、ページ上部のナビゲーションで予算を使い切り後方が落ちる。
 * かといって日付の周辺を集めるだけでは、日付が密なまとめサイトでは窓が全体に融合して
 * 結局先頭切り出しと変わらない（実測: wannyan-smile.com は606件中163件しか載らなかった）。
 * そこで収集期間内の日付を含む範囲を優先し、残り予算で期間外も拾う。
 */
export function extractRelevant(text, limit, range = null) {
  if (text.length <= limit) return text;

  const inRange = [];
  const others = [];
  for (const m of text.matchAll(DATE_PATTERN)) {
    const win = [Math.max(0, m.index - 120), Math.min(text.length, m.index + 220)];
    const iso = toIsoDate(m, range);
    if (range && iso && iso >= range.today && iso <= range.horizon) inRange.push(win);
    else others.push(win);
  }
  if (inRange.length === 0 && others.length === 0) return text.slice(0, limit);

  let out = '';
  for (const group of [inRange, others]) {
    for (const [start, end] of mergeWindows(group)) {
      if (out.length >= limit) break;
      out += (out ? ' … ' : '') + text.slice(start, end);
    }
  }
  return out.slice(0, limit);
}

// 「2026年10月3日」「10月3日」「2026/10/03」「10/3」などを拾う
const DATE_PATTERN = /(?:(20\d{2})\s?[年/-]\s?)?(\d{1,2})\s?[月/-]\s?(\d{1,2})\s?日?/g;

/**
 * 正規表現のマッチをYYYY-MM-DDへ変換する。
 * 年の記載がない場合は、収集期間に収まる方の年を採用する（まとめサイトは年を省くことが多い）。
 */
function toIsoDate(m, range) {
  const [, y, mo, d] = m;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const pad = (n) => String(n).padStart(2, '0');
  if (y) return `${y}-${pad(month)}-${pad(day)}`;
  if (!range) return null;
  // 年が無いときは期間の開始年と終了年の両方を試す
  for (const year of new Set([range.today.slice(0, 4), range.horizon.slice(0, 4)])) {
    const iso = `${year}-${pad(month)}-${pad(day)}`;
    if (iso >= range.today && iso <= range.horizon) return iso;
  }
  return null;
}

function mergeWindows(windows) {
  const sorted = [...windows].sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const w of sorted) {
    const last = merged[merged.length - 1];
    if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
    else merged.push([...w]);
  }
  return merged;
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
