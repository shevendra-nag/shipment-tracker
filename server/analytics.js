import { InputError } from './validation.js';
import { STATUS } from './constants.js';

const DAYS = [7, 30, 90, 365];
const toDay = (value) => value && typeof value === 'string' ? value.slice(0, 10) : '';
const dayStart = (day) => Date.parse(`${day}T00:00:00Z`);
const diffDays = (end, start) => (Date.parse(end) - Date.parse(start)) / 86_400_000;
const pct = (num, den) => den ? Math.round(num / den * 1000) / 10 : null;

export function buildAnalytics(shipments, period = 30, now = new Date()) {
  const days = Number(period);
  if (!DAYS.includes(days)) throw new InputError('Analytics period must be 7, 30, 90, or 365 days.');
  const today = now.toISOString().slice(0, 10);
  const todayTime = dayStart(today);
  const startTime = todayTime - (days - 1) * 86_400_000;
  const buckets = [];
  const interval = days <= 30 ? 1 : days <= 90 ? 7 : 30;
  for (let day = 0; day < days; day += interval) {
    const first = new Date(startTime + day * 86_400_000).toISOString().slice(0, 10);
    const last = new Date(startTime + Math.min(days - 1, day + interval - 1) * 86_400_000).toISOString().slice(0, 10);
    buckets.push({ label: days <= 30 ? new Date(`${first}T12:00:00Z`).toLocaleDateString('en-US', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : `${first.slice(5)} – ${last.slice(5)}`, start: first, end: last, created: 0, delivered: 0 });
  }
  const counts = Object.fromEntries(Object.keys(STATUS).map(s => [s, 0]));
  const carriers = new Map();
  let overdue = 0, recentlyCreated = 0, recentlyDelivered = 0;
  let measured = 0, onTime = 0, transitCount = 0, transitSum = 0;
  for (const s of shipments) {
    counts[s.status] = (counts[s.status] || 0) + 1;
    if (s.estimatedDelivery && s.estimatedDelivery < today && s.status !== 'delivered') overdue++;
    const createdDay = toDay(s.createdAt);
    const deliveredDay = toDay(s.deliveredAt);
    if (createdDay && dayStart(createdDay) >= startTime && dayStart(createdDay) <= todayTime) recentlyCreated++;
    if (deliveredDay && dayStart(deliveredDay) >= startTime && dayStart(deliveredDay) <= todayTime) recentlyDelivered++;
    const createdBucket = buckets.find(b => createdDay && createdDay >= b.start && createdDay <= b.end);
    const deliveredBucket = buckets.find(b => deliveredDay && deliveredDay >= b.start && deliveredDay <= b.end);
    if (createdBucket) createdBucket.created++;
    if (deliveredBucket) deliveredBucket.delivered++;
    const key = s.carrier || 'Other';
    const stat = carriers.get(key) || { carrier: key, total: 0, delivered: 0, exceptions: 0, overdue: 0 };
    stat.total++;
    if (s.status === 'delivered') stat.delivered++;
    if (s.status === 'exception') stat.exceptions++;
    if (s.estimatedDelivery && s.estimatedDelivery < today && s.status !== 'delivered') stat.overdue++;
    carriers.set(key, stat);
    if (s.status === 'delivered' && s.deliveredAt && s.estimatedDelivery) {
      measured++;
      if (deliveredDay <= s.estimatedDelivery) onTime++;
    }
    if (s.status === 'delivered' && s.shippedAt && s.deliveredAt && Date.parse(s.deliveredAt) >= dayStart(s.shippedAt)) {
      const duration = diffDays(s.deliveredAt, `${s.shippedAt}T00:00:00Z`);
      if (Number.isFinite(duration) && duration >= 0) { transitCount++; transitSum += duration; }
    }
  }
  return {
    period: days, total: shipments.length, counts, active: shipments.length - (counts.delivered || 0),
    overdue, deliveredInPeriod: recentlyDelivered, createdInPeriod: recentlyCreated,
    onTimeRate: pct(onTime, measured), onTimeSample: measured,
    deliveredRate: pct(counts.delivered || 0, shipments.length),
    exceptionRate: pct(counts.exception || 0, shipments.length),
    avgTransitDays: transitCount ? Math.round(transitSum / transitCount * 10) / 10 : null,
    trend: buckets, carriers: [...carriers.values()].map(s => ({ ...s, deliveryRate: pct(s.delivered, s.total) })).sort((a, b) => b.total - a.total || a.carrier.localeCompare(b.carrier)).slice(0, 15),
  };
}
