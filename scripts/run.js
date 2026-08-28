import { readFile, writeFile } from 'node:fs/promises';
import { fetchKnownSources } from './fetch_known_sources.js';
import { extractEvents } from './extract_events.js';
import { estimateAttendance } from './estimate_attendance.js';
import { syncCalendar } from './sync_calendar.js';
import { addMonths, todayJst } from './lib/date.js';

// 実行時のカレントディレクトリに依存しないよう、スクリプト位置を基準に解決する
const EVENTS_PATH = new URL('../data/events.json', import.meta.url);

// 収集対象期間（docs/plan.md 3章「直近〜6ヶ月先」）
const HORIZON_MONTHS = 6;

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

async function main() {
  const today = todayJst();
  const horizon = addMonths(today, HORIZON_MONTHS);

  console.log('=== 東海犬イベント自動収集 開始 ===');
  console.log(`収集対象期間: ${today} 〜 ${horizon}`);
  if (DRY_RUN) {
    console.log('*** DRY RUN: カレンダー登録と events.json の更新は行いません ***');
  }

  const [knownSourcePages, existingEventsRaw] = await Promise.all([
    fetchKnownSources(),
    readFile(EVENTS_PATH, 'utf-8'),
  ]);
  const existingEvents = JSON.parse(existingEventsRaw);

  console.log(`公式サイト取得: ${knownSourcePages.length}件 / 既存イベント: ${existingEvents.length}件`);
  console.log('Claudeによる検索・抽出を実行中...');

  // Web検索はAnthropicのサーバー側ツールで行うため、ここでは呼び出さない
  const { events: extracted, candidates } = await extractEvents({
    knownSourcePages,
    today,
    horizon,
  });

  // 候補と除外理由を必ず残す。「取りこぼし」と「意図的な除外」を後から区別するため。
  // 除外理由が期間外・県外・小規模以外のものは、抽出基準の見直しを検討する材料になる。
  console.log(`検出候補: ${candidates.length}件 / うち採用: ${extracted.length}件`);
  const excludedCandidates = candidates.filter((c) => !c.included);
  if (excludedCandidates.length > 0) {
    console.log(`除外された候補: ${excludedCandidates.length}件`);
    for (const c of excludedCandidates) {
      console.log(`  - ${c.name}${c.date ? ` (${c.date})` : ''} ※${c.reason || '理由の記載なし'}`);
    }
  }
  if (candidates.length > 0 && candidates.length < extracted.length) {
    console.warn('[警告] 候補数が採用数を下回っています。candidates の記録漏れの可能性があります');
  }

  // プロンプトでも期間を指示しているが、モデルの判断だけに委ねず機械的に再フィルタする。
  // これは plan.md 6章「開催終了・次回未発表のイベントは登録しない」も同時に満たす。
  const inRange = extracted.filter((ev) => isWithinRange(ev, today, horizon));
  const outOfRange = extracted.length - inRange.length;
  if (outOfRange > 0) {
    console.log(`期間外として除外: ${outOfRange}件（${today} 〜 ${horizon} の範囲外）`);
  }

  const collectedAt = today;
  const withAttendance = [];

  for (const ev of inRange) {
    const id = buildId(ev);

    if (ev.attendance_status === 'confirmed' && ev.attendance_value != null) {
      withAttendance.push({
        ...toEventShape(ev, id),
        attendance: { status: 'confirmed', value: ev.attendance_value, collected_at: collectedAt },
      });
      continue;
    }

    // 未発表 → Claude APIで予測
    const prediction = await estimateAttendance(ev);
    withAttendance.push({
      ...toEventShape(ev, id),
      attendance: {
        status: 'predicted',
        min: prediction.min,
        max: prediction.max,
        basis: prediction.basis,
        collected_at: collectedAt,
      },
    });
  }

  const updatedEvents = await syncCalendar({
    newEvents: withAttendance,
    existingEvents,
    dryRun: DRY_RUN,
  });

  if (DRY_RUN) {
    console.log('\n=== DRY RUN 結果（events.json には書き込みません） ===');
    console.log(JSON.stringify(withAttendance, null, 2));
    console.log(`\n=== 完了: ${withAttendance.length}件を検出（合計${updatedEvents.length}件相当） ===`);
    return;
  }

  await writeFile(EVENTS_PATH, JSON.stringify(updatedEvents, null, 2) + '\n', 'utf-8');
  console.log(`=== 完了: events.json を更新しました（合計${updatedEvents.length}件） ===`);
}

/**
 * 開催期間が収集対象ウィンドウと重なっているか。
 * 開催中のイベント（開始済み・未終了）も対象に含める。
 */
function isWithinRange(ev, today, horizon) {
  if (!ev.start_date || !ev.end_date) return false;
  return ev.end_date >= today && ev.start_date <= horizon;
}

function toEventShape(ev, id) {
  return {
    id,
    series_id: guessSeriesId(ev.name),
    name: ev.name,
    prefecture: ev.prefecture,
    venue: ev.venue,
    address: ev.address ?? '',
    start_date: ev.start_date,
    end_date: ev.end_date,
    source_url: ev.source_url,
    venue_type: ev.venue_type ?? 'その他・不明',
    admission: ev.admission ?? '不明',
    booth_count: ev.booth_count ?? null,
  };
}

function buildId(ev) {
  const slug = ev.name.replace(/[^\p{L}\p{N}]+/gu, '-').toLowerCase();
  return `${slug}-${ev.start_date}`;
}

function guessSeriesId(name) {
  if (name.includes('わんにゃんドーム')) return 'wannyandome';
  if (name.includes('犬市場')) return 'inuichiba';
  if (name.includes('インターペット')) {
    return name.includes('大阪') ? 'interpets_osaka' : 'interpets_tokyo';
  }
  // 「wandarake marche 51&52」「wandarake fest! 47&48」「わんだらけマルシェ」など表記が揺れる
  if (/wandarake|わんだらけ/i.test(name)) return 'wandarake';
  return null;
}

main().catch((err) => {
  console.error('実行中にエラーが発生しました:', err);
  process.exitCode = 1;
});
