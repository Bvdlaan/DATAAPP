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
  const values: (number | null)[] = Array.isArray(ds.value) ? ds.value : Object.values(ds.value ?? {});

  const rows: Record<string, string | number | null>[] = [];
  for (let i = 0; i < values.length && rows.length < maxRows; i++) {
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
    totalCells: values.length,
    truncated: values.length > rows.length,
    rows,
  };
}
