import { getCalendarClient, insertEvent, patchEvent } from './lib/googleCalendar.js';
import { todayJst } from './lib/date.js';

// 終了から この日数 を過ぎたイベントは events.json から落とす（状態ファイルの肥大化防止）
const RETENTION_DAYS = 365;

/**
 * 「開催日＋イベント名の緩い一致（表記ゆれ許容）」で同一イベントかどうかを判定する。
 */
function isSameEvent(a, b) {
  if (a.start_date !== b.start_date) return false;
  const normalize = (s) => s.replace(/[\s　]/g, '').toLowerCase();
  const na = normalize(a.name);
  const nb = normalize(b.name);
  return na.includes(nb) || nb.includes(na);
}

/**
 * 新規抽出イベントを既存のevents.jsonと突合し、Google Calendarへ反映する。
 * - 新規イベント: insert
 * - 既存イベント: 日程/会場に変化があった場合、または予測→確定に変わった場合のみpatch
 * - 開催終了・次回未発表のイベントは呼び出し側（run.js）で既にフィルタ済みの前提
 *
 * dryRun=true のときはCalendar APIを一切呼ばず、判定結果のログだけ出す。
 * このときGoogle系の環境変数は不要（クライアントを生成しない）。
 */
export async function syncCalendar({ newEvents, existingEvents, dryRun = false }) {
  // ドライラン時は認証情報を要求しないよう、クライアント生成を遅延させる
  const calendar = dryRun ? null : getCalendarClient();
  const tag = dryRun ? 'DRY-RUN ' : '';
  const result = [...existingEvents];

  for (const incoming of newEvents) {
    const existingIndex = result.findIndex((e) => isSameEvent(e, incoming));
    const existing = existingIndex === -1 ? null : result[existingIndex];

    // 既存レコードでもcalendar_event_idを持たない場合（過去のドライラン結果など）は
    // patchできないため新規登録として扱う
    const needsInsert = !existing || !existing.calendar_event_id;

    if (needsInsert) {
      const calendarEventId = dryRun ? null : await insertEvent(calendar, incoming);
      const record = { ...incoming, calendar_event_id: calendarEventId, last_checked: today() };
      if (existing) {
        result[existingIndex] = record;
      } else {
        result.push(record);
      }
      console.log(`[${tag}新規登録] ${incoming.name} (${incoming.start_date})`);
      continue;
    }

    // 既存レコードにattendanceが無いケース（古い形式）でも落ちないようにし、
    // かつ今回の値で補完する（放置すると永久に欠落したままになるため）
    const missingAttendance = !existing.attendance;
    const becameConfirmed =
      existing.attendance?.status !== 'confirmed' && incoming.attendance.status === 'confirmed';
    const scheduleChanged = existing.end_date !== incoming.end_date || existing.venue !== incoming.venue;

    if (missingAttendance || becameConfirmed || scheduleChanged) {
      if (!dryRun) {
        await patchEvent(calendar, existing.calendar_event_id, incoming);
      }
      result[existingIndex] = {
        ...incoming,
        calendar_event_id: existing.calendar_event_id,
        last_checked: today(),
      };
      const reason = becameConfirmed
        ? '※予測→確定'
        : scheduleChanged
          ? '※日程/会場変更'
          : '※来場者数情報の補完';
      console.log(`[${tag}更新] ${incoming.name} (${incoming.start_date}) ${reason}`);
    } else {
      result[existingIndex] = { ...existing, last_checked: today() };
      console.log(`[${tag}スキップ] ${incoming.name} (${incoming.start_date}) ※変更なし`);
    }
  }

  return pruneOldEvents(result);
}

/**
 * 終了から RETENTION_DAYS を過ぎたイベントを除去する。
 * カレンダー側の予定は消さない（記録として残す）。
 */
function pruneOldEvents(events) {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const kept = events.filter((e) => !e.end_date || e.end_date >= cutoff);
  const removed = events.length - kept.length;
  if (removed > 0) {
    console.log(`[整理] ${cutoff} より前に終了したイベント ${removed}件 を events.json から除去`);
  }
  return kept;
}

function today() {
  return todayJst();
}
