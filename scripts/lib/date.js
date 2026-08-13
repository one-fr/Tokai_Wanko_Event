const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * JST基準の「今日」をYYYY-MM-DDで返す。
 *
 * GitHub Actionsのランナーは UTC で動くため、単純な toISOString() では
 * 日本時間の月曜6:00に実行しても前日（日曜）の日付になってしまう。
 * 開催日の絞り込み境界に効いてくるので、JSTに寄せて判定する。
 */
export function todayJst(now = new Date()) {
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * YYYY-MM-DD にNヶ月を加算した YYYY-MM-DD を返す。
 * 実行環境のタイムゾーンに影響されないよう UTC 上で計算する。
 */
export function addMonths(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1 + months, d));
  return utc.toISOString().slice(0, 10);
}
