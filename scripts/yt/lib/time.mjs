export function datePartsIn(timeZone, date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

export function dateStringIn(timeZone, date) {
  const { year, month, day } = datePartsIn(timeZone, date);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// 쿼터는 태평양 시간 자정에 초기화된다.
export function ptDate(date) {
  return dateStringIn('America/Los_Angeles', date);
}
