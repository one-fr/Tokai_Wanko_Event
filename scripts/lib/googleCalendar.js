import { google } from 'googleapis';

function loadCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) {
    throw new Error('環境変数 GOOGLE_SERVICE_ACCOUNT_KEY が設定されていません');
  }
  // GitHub SecretsにはJSON文字列そのもの、またはbase64エンコードしたものどちらでも登録できるようにする
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf-8'));
  }
}

export function getCalendarClient() {
  const credentials = loadCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  return google.calendar({ version: 'v3', auth });
}

function calendarId() {
  const id = process.env.GOOGLE_CALENDAR_ID;
  if (!id) {
    throw new Error('環境変数 GOOGLE_CALENDAR_ID が設定されていません');
  }
  return id;
}

/**
 * 複数日開催イベントも1つの終日イベントとして登録する。
 * Google Calendarの終日イベント仕様上、endは「終了日の翌日」を指定する（exclusive end）。
 */
export async function insertEvent(calendar, event) {
  const res = await calendar.events.insert({
    calendarId: calendarId(),
    requestBody: buildEventBody(event),
  });
  return res.data.id;
}

export async function patchEvent(calendar, calendarEventId, event) {
  await calendar.events.patch({
    calendarId: calendarId(),
    eventId: calendarEventId,
    requestBody: buildEventBody(event),
  });
}

function buildEventBody(event) {
  return {
    summary: `【犬イベント】${event.name}`,
    location: event.address || event.venue,
    description: buildDescription(event),
    start: { date: event.start_date },
    end: { date: addDays(event.end_date, 1) },
  };
}

// タイムゾーンに依存しない純粋なカレンダー日付演算。
// GitHub Actionsランナー（UTC）で `new Date(dateStr + 'T00:00:00+09:00')` を使うと、
// ローカルのgetDate()/setDate()が実行環境のタイムゾーンに引きずられて日付が1日ずれるため、
// Date.UTC + setUTCDate で明示的にUTC上の計算に固定する。
function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcDate = new Date(Date.UTC(y, m - 1, d));
  utcDate.setUTCDate(utcDate.getUTCDate() + days);
  return utcDate.toISOString().slice(0, 10);
}

function buildDescription(event) {
  const a = event.attendance;
  const statusLabel = a.status === 'confirmed' ? '確定（公式発表）' : '未発表（AI予測）';
  const attendanceLine =
    a.status === 'confirmed'
      ? `【来場者数】${a.value.toLocaleString('ja-JP')}人（確定・公式発表）`
      : `【来場者数】約${a.min.toLocaleString('ja-JP')}〜${a.max.toLocaleString('ja-JP')}人（AI推定 / 根拠: ${a.basis}）`;

  return [
    attendanceLine,
    `【ステータス】${statusLabel}`,
    `【情報源】${event.source_url}`,
    `【収集日】${a.collected_at}`,
  ].join('\n');
}
