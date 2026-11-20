/** Turn a JSON-stat2 dataset into readable rows: [{ region: "Sweden", sex: "men", month: "2026M09", value: 5336571 }]. */
export function flattenJsonStat(ds: any, maxRows = 200) {
  const ids: string[] = ds.id;
  const sizes: number[] = ds.size;
  const cats = ids.map((id) => {
    const c = ds.dimension[id].category;
    const index: Record<string, number> = c.index ?? {};
    return Object.keys(index)
      .sort((a, b) => index[a] - index[b])
      .map((code) => c.label?.[code] ?? code);
  });
  const names = ids.map((id) => ds.dimension[id].label ?? id);
  // JSON-stat allows a dense array or a sparse { "index": value } object (Eurostat uses the latter).
  const total = sizes.reduce((a, b) => a * b, 1);
  let values: (number | null)[];
  if (Array.isArray(ds.value)) values = ds.value;
  else {
    values = new Array(total).fill(null);
    for (const [k, v] of Object.entries(ds.value ?? {})) values[Number(k)] = v as number;
  }

  const rows: Record<string, string | number | null>[] = [];
  let nonNull = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] === null || values[i] === undefined) continue; // skip empty cells
    nonNull++;
    if (rows.length >= maxRows) continue;
    // Row-major order: last dimension varies fastest.
    const pos: number[] = new Array(ids.length);
    let rem = i;
    for (let d = ids.length - 1; d >= 0; d--) {
      pos[d] = rem % sizes[d];
      rem = Math.floor(rem / sizes[d]);
    }
    const row: Record<string, string | number | null> = {};
    ids.forEach((_, d) => (row[names[d]] = cats[d][pos[d]]));
    row.value = values[i];
    rows.push(row);
  }
  return {
    label: ds.label,
    updated: ds.updated,
    source: ds.source,
    totalCells: nonNull,
    truncated: nonNull > rows.length,
    rows,
  };
}
