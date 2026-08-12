import { readFile, writeFile } from 'node:fs/promises';
import { fetchKnownSources } from './fetch_known_sources.js';
import { searchWeb } from './search_web.js';
import { extractEvents } from './extract_events.js';
import { estimateAttendance } from './estimate_attendance.js';
import { syncCalendar } from './sync_calendar.js';

const EVENTS_PATH = 'data/events.json';

async function main() {
  console.log('=== 東海犬イベント自動収集 開始 ===');

  const [knownSourcePages, searchResults, existingEventsRaw] = await Promise.all([
    fetchKnownSources(),
    searchWeb(),
    readFile(EVENTS_PATH, 'utf-8'),
  ]);
  const existingEvents = JSON.parse(existingEventsRaw);

  console.log(`公式サイト取得: ${knownSourcePages.length}件 / Web検索結果: ${searchResults.length}件`);

  const extracted = await extractEvents({ knownSourcePages, searchResults });
  console.log(`抽出されたイベント: ${extracted.length}件`);

  const collectedAt = new Date().toISOString().slice(0, 10);
  const withAttendance = [];

  for (const ev of extracted) {
    const id = buildId(ev);

    if (ev.attendance_status === 'confirmed' && ev.attendance_value != null) {
      withAttendance.push({
        ...toEventShape(ev, id),
        attendance: { status: 'confirmed', value: ev.attendance_value, collected_at: collectedAt },
      });
      continue;
    }

    // 未発表 → Claude APIで予測（「12. 開催終了・次回未発表イベントは登録しない」方針は
    // extract_events側で「開催が確認できるイベントのみ」抽出する設計により自然に満たされる）
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

  const updatedEvents = await syncCalendar({ newEvents: withAttendance, existingEvents });

  await writeFile(EVENTS_PATH, JSON.stringify(updatedEvents, null, 2) + '\n', 'utf-8');
  console.log(`=== 完了: events.json を更新しました（合計${updatedEvents.length}件） ===`);
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
  };
}

function buildId(ev) {
  const slug = ev.name.replace(/[^\p{L}\p{N}]+/gu, '-').toLowerCase();
  return `${slug}-${ev.start_date}`;
}

function guessSeriesId(name) {
  if (name.includes('わんにゃんドーム')) return 'wannyandome';
  if (name.includes('犬市場')) return 'inuichiba';
  return null;
}

main().catch((err) => {
  console.error('実行中にエラーが発生しました:', err);
  process.exitCode = 1;
});
