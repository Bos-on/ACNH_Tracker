export const TAB_DEFINITIONS = Object.freeze({
  bug: Object.freeze({ label: '虫', filters: Object.freeze(['location', 'weather']) }),
  fish: Object.freeze({ label: '鱼', filters: Object.freeze(['location', 'shadowSize']) }),
  sea: Object.freeze({ label: '海洋生物', filters: Object.freeze(['shadowSize']) })
});

export const TABS = Object.freeze(Object.keys(TAB_DEFINITIONS));

export function shiftMonths(months) {
  return months.map(month => ((month + 5) % 12) + 1).sort((a, b) => a - b);
}

export function monthsForHemisphere(item, hemisphere) {
  return hemisphere === 'south' ? item.southMonths : item.northMonths;
}
