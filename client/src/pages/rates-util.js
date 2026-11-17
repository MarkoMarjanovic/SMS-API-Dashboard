/** Monthly-equivalent amount of an active recurring fee (one-time fees count as 0). */
export function fixedMonthly(f) {
  const today = new Date().toISOString().slice(0, 10);
  if (f.end_date && f.end_date < today) return 0;
  if (f.frequency === 'monthly') return Number(f.amount) || 0;
  if (f.frequency === 'annual') return (Number(f.amount) || 0) / 12;
  return 0;
}
