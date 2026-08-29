import { readFile, writeFile } from 'node:fs/promises';
import { todayJst } from './date.js';

// 実行時のカレントディレクトリに依存しないよう、スクリプト位置を基準に解決する
const KNOWN_PATH = new URL('../../data/known_sources.json', import.meta.url);
const DISCOVERED_PATH = new URL('../../data/discovered_sources.json', import.meta.url);

// 自動学習した情報源の保持上限。入力トークンが膨らみすぎないよう制限する
const MAX_DISCOVERED = 8;

// 1回の実行でこの件数以上のイベントを供給したURLを「一覧ページ」とみなして学習する。
// 1件しか出ないURLは個別イベントのページである可能性が高く、次回以降は陳腐化するため学習しない
const MIN_EVENTS_TO_LEARN = 2;

// 連続でこの回数ヒットしなかった情報源は削除する（更新停止・構成変更への追随）
const MAX_MISSES = 3;

/**
 * 巡回対象の情報源を読み込む。
 * - curated: 手で登録した公式サイト（data/known_sources.json）
 * - discovered: 実行結果から自動学習したイベントまとめサイト（data/discovered_sources.json）
 */
export async function loadSources() {
  const curated = JSON.parse(await readFile(KNOWN_PATH, 'utf-8')).map((s) => ({
    kind: 'curated',
    series_id: s.series_id,
    name: s.name,
    url: s.official_url,
    notes: s.notes ?? '',
  }));

  let discovered = [];
  try {
    discovered = JSON.parse(await readFile(DISCOVERED_PATH, 'utf-8')).map((s) => ({
      kind: 'discovered',
      series_id: null,
      name: s.hostname,
      url: s.url,
      notes: `自動学習したイベントまとめサイト（これまでに${s.events_seen}件のイベントを供給）`,
    }));
  } catch {
    // ファイルが無い初回実行では空で続行する
  }

  return [...curated, ...discovered];
}

/**
 * 抽出結果から情報源を学習し、data/discovered_sources.json を更新する。
 *
 * 公式サイトとして既にknown_sourcesに登録済みのホストは学習しない（重複巡回を避ける）。
 * ヒットしなかった既存の情報源はmissesを増やし、続くようなら削除する。
 */
export async function updateDiscoveredSources(events) {
  const curatedHosts = new Set(
    JSON.parse(await readFile(KNOWN_PATH, 'utf-8')).map((s) => hostOf(s.official_url)).filter(Boolean)
  );

  let list = [];
  try {
    list = JSON.parse(await readFile(DISCOVERED_PATH, 'utf-8'));
  } catch {
    // 初回は空から始める
  }

  // このURLが何件のイベントを供給したかを数える
  const hits = new Map();
  for (const ev of events) {
    if (!ev.source_url) continue;
    hits.set(ev.source_url, (hits.get(ev.source_url) ?? 0) + 1);
  }

  const today = todayJst();
  const byUrl = new Map(list.map((s) => [s.url, s]));
  const added = [];

  for (const [url, count] of hits) {
    const host = hostOf(url);
    if (!host || curatedHosts.has(host)) continue;

    const existing = byUrl.get(url);
    if (existing) {
      existing.events_seen += count;
      existing.last_hit = today;
      existing.misses = 0;
      continue;
    }
    // 一覧ページと判断できる件数を供給したURLだけ学習する
    if (count < MIN_EVENTS_TO_LEARN) continue;

    const record = {
      url, hostname: host, events_seen: count,
      first_seen: today, last_hit: today, misses: 0,
    };
    byUrl.set(url, record);
    list.push(record);
    added.push(record);
  }

  // ヒットしなかった情報源のmissesを増やし、続いたものは削除する
  const removed = [];
  for (const s of list) {
    if (hits.has(s.url)) continue;
    s.misses = (s.misses ?? 0) + 1;
  }
  let kept = list.filter((s) => {
    if ((s.misses ?? 0) >= MAX_MISSES) { removed.push(s); return false; }
    return true;
  });

  // 供給実績の多い順に上限まで残す
  kept.sort((a, b) => b.events_seen - a.events_seen);
  const overflow = kept.slice(MAX_DISCOVERED);
  kept = kept.slice(0, MAX_DISCOVERED);

  await writeFile(DISCOVERED_PATH, JSON.stringify(kept, null, 2) + '\n', 'utf-8');

  return { added, removed: [...removed, ...overflow], total: kept.length };
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
