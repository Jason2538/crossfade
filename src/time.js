const DAY = 86400;

export const nowSeconds = () => Math.floor(Date.now() / 1000);

// offset 0은 이번 주, 1은 지난주입니다. 한 주는 월요일 0시에 시작합니다.
export function weekRange(offset, nowSec, tzMinutes) {
  const tz = tzMinutes * 60;
  const localDay = Math.floor((nowSec + tz) / DAY);
  const monday = localDay - mondayIndex(localDay) - offset * 7;
  const start = monday * DAY - tz;
  return { start, end: start + 7 * DAY };
}

export function localParts(sec, tzMinutes) {
  const local = sec + tzMinutes * 60;
  const day = Math.floor(local / DAY);
  return { dow: mondayIndex(day), hour: Math.floor((local - day * DAY) / 3600) };
}

// 1970-01-01은 목요일이므로 3을 더하면 월요일이 0이 됩니다.
function mondayIndex(localDay) {
  return ((localDay + 3) % 7 + 7) % 7;
}
