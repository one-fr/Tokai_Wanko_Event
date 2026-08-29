import { readFile, writeFile } from 'node:fs/promises';
import { todayJst } from './date.js';

// 実行時のカレントディレクトリに依存しないよう、スクリプト位置を基準に解決する
const KNOWN_PATH = new URL('../../data/known_sources.json', import.meta.url);
const DISCOVERED_PATH = new URL('../../data/discovered_sources.json', import.meta.url);

// 自動学習した情報源の保持上限。入力トークンが膨らみすぎないよう制限する
const MAX_DISCOVERED = 12;

// 同一ホストから保持するURLの上限。月別記事など複数URLを持つサイトに枠を占有させない
const MAX_PER_HOST = 2;

// イベントを供給したURLは1件からすぐ学習する。
// 「一覧ページか単発記事か」をページ内容から見分ける試みは失敗した
// （実測: 良質な inumatsuri.com は期間内の日付6件、単発記事の odekake-wanko-bu.com は18件で逆転）。
// 判定は時間に任せる方が確実で、続けてヒットするかどうかで選別する。
const MIN_EVENTS_TO_LEARN = 1;

// 連続でこの回数ヒットしなかった情報源は削除する（更新停止・構成変更への追随）
const MAX_MISSES = 3;

// 供給実績が1件だけのまま不発になった情報源は、単発記事とみなして早めに削除する。
// 掲載イベントが終われば二度とヒットしないため、枠を占有させない
const QUICK_PRUNE_MISSES = 1;

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
    if (count < MIN_EVENTS_TO_LEARN) continue;

    const record = {
      url, hostname: host, events_seen: count,
      first_seen: today, last_hit: today, misses: 0,
    };
    byUrl.set(url, record);
    list.push(record);
    added.push(record);
  }

  // ヒットしなかった情報源のmissesを増やす
  const removed = [];
  for (const s of list) {
    if (hits.has(s.url)) continue;
    s.misses = (s.misses ?? 0) + 1;
  }

  let kept = list.filter((s) => {
    const misses = s.misses ?? 0;
    if (misses >= MAX_MISSES) { removed.push(s); return false; }
    // 1件供給しただけで不発になったものは単発記事と判断して早期に落とす
    if (s.events_seen <= 1 && misses >= QUICK_PRUNE_MISSES) { removed.push(s); return false; }
    return true;
  });

  // 供給実績の多い順に並べ、同一ホストの占有と総数を制限する
  kept.sort((a, b) => b.events_seen - a.events_seen);
  const perHost = new Map();
  const survivors = [];
  for (const s of kept) {
    const n = perHost.get(s.hostname) ?? 0;
    if (n >= MAX_PER_HOST || survivors.length >= MAX_DISCOVERED) { removed.push(s); continue; }
    perHost.set(s.hostname, n + 1);
    survivors.push(s);
  }
  kept = survivors;

  await writeFile(DISCOVERED_PATH, JSON.stringify(kept, null, 2) + '\n', 'utf-8');

  // 学習直後に枠から溢れたものは added から除く
  const keptUrls = new Set(kept.map((s) => s.url));
  return {
    added: added.filter((s) => keptUrls.has(s.url)),
    removed,
    total: kept.length,
  };
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
