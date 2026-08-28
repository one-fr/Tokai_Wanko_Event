import { getCalendarClient, insertEvent, patchEvent } from './lib/googleCalendar.js';
import { todayJst } from './lib/date.js';

// 終了から この日数 を過ぎたイベントは events.json から落とす（状態ファイルの肥大化防止）
const RETENTION_DAYS = 365;

// イベント名の類似度がこの値以上なら同一イベントとみなす。
// 実測: 「犬祭りテラス」⇔「犬祭り in テラスゲート土岐」= 0.47、
//       「デカケルわんこびより in モリコロパーク」⇔「海津アクア×木曽三川わんこマルシェ2026秋」= 0.10
const NAME_SIMILARITY_THRESHOLD = 0.4;

const normalize = (s) => (s ?? '').replace(/[\s　]/g, '').toLowerCase();

/**
 * 文字バイグラムのDice係数（0〜1）。
 * 日本語は単語境界がないため、形態素解析なしで表記ゆれを吸収できるこの方式を使う。
 */
export function nameSimilarity(a, b) {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const bigrams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  let intersection = 0;
  let total = 0;
  for (const [g, n] of A) {
    total += n;
    if (B.has(g)) intersection += Math.min(n, B.get(g));
  }
  for (const [, n] of B) total += n;
  return total === 0 ? 0 : (2 * intersection) / total;
}

/**
 * 「開催日＋イベント名の緩い一致（表記ゆれ許容）」で同一イベントかどうかを判定する。
 *
 * 開催日の一致は必須条件のまま。同名シリーズの別開催回（犬祭り 8/29・9/12・12/13 など）を
 * 誤って統合しないため、ここは緩めない。
 *
 * 名称は部分一致だけでは「犬祭りテラス」「犬祭り（テラスゲート土岐）」「犬祭り in テラスゲート土岐」の
 * ような揺れを吸収できず、実際に同一イベントが3件重複登録された。Dice係数による類似判定を追加する。
 */
export function isSameEvent(a, b) {
  if (a.start_date !== b.start_date) return false;

  const na = normalize(a.name);
  const nb = normalize(b.name);
  if (na.includes(nb) || nb.includes(na)) return true;
  if (nameSimilarity(na, nb) >= NAME_SIMILARITY_THRESHOLD) return true;

  // 名称が大きく違っても、同日・同会場なら同一イベントとみなす（取りこぼしの保険）
  const va = normalize(a.venue);
  const vb = normalize(b.venue);
  if (va && vb && (va.includes(vb) || vb.includes(va))) return true;

  return false;
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
