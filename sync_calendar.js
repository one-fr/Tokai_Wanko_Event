import { getCalendarClient, insertEvent, patchEvent } from './lib/googleCalendar.js';

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
 */
export async function syncCalendar({ newEvents, existingEvents }) {
  const calendar = getCalendarClient();
  const result = [...existingEvents];

  for (const incoming of newEvents) {
    const existingIndex = result.findIndex((e) => isSameEvent(e, incoming));

    if (existingIndex === -1) {
      const calendarEventId = await insertEvent(calendar, incoming);
      result.push({ ...incoming, calendar_event_id: calendarEventId, last_checked: today() });
      console.log(`[新規登録] ${incoming.name} (${incoming.start_date})`);
      continue;
    }

    const existing = result[existingIndex];
    const becameConfirmed = existing.attendance.status !== 'confirmed' && incoming.attendance.status === 'confirmed';
    const scheduleChanged = existing.end_date !== incoming.end_date || existing.venue !== incoming.venue;

    if (becameConfirmed || scheduleChanged) {
      await patchEvent(calendar, existing.calendar_event_id, incoming);
      result[existingIndex] = {
        ...incoming,
        calendar_event_id: existing.calendar_event_id,
        last_checked: today(),
      };
      console.log(
        `[更新] ${incoming.name} (${incoming.start_date}) ${becameConfirmed ? '※予測→確定' : '※日程/会場変更'}`
      );
    } else {
      result[existingIndex] = { ...existing, last_checked: today() };
    }
  }

  return result;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}
