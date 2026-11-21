export function summarizeByTeam(rows) {
  const totals = new Map();
  for (const row of rows) {
    if (!row || typeof row.team !== "string" || !Number.isFinite(row.value))
      continue;
    totals.set(row.team, (totals.get(row.team) ?? 0) + row.value);
  }
  return [...totals].map(([key, value]) => ({ key, value }));
}

export function summarizeByRegion(rows) {
  const totals = new Map();
  for (const row of rows) {
    if (!row || typeof row.region !== "string" || !Number.isFinite(row.value))
      continue;
    totals.set(row.region, (totals.get(row.region) ?? 0) + row.value);
  }
  return [...totals].map(([key, value]) => ({ key, value }));
}
