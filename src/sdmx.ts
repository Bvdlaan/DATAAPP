// Shared reader for SDMX-JSON 1.0 data messages (ECB, Norges Bank).
// Spec: https://github.com/sdmx-twg/sdmx-json — series keys like "0:2:0" index into the series dimensions,
// observation keys index into the time dimension, and attribute arrays index into each attribute's values.

export interface SdmxSeries {
  key: string;
  dimensions: Record<string, string | undefined>;
  attributes: Record<string, string | undefined>;
  observations: { period: string; value: number | null }[];
  totalObservations: number;
}

const label = (v: any) => (v ? (v.name && v.name !== v.id ? `${v.id} (${v.name})` : v.id) : undefined);

/** Both wrappings occur: { data: { structure, dataSets } } (Norges Bank) and { structure, dataSets } (ECB). */
export function sdmxParts(json: any) {
  const root = json?.data?.dataSets ? json.data : json;
  return { structure: root?.structure, dataSet: root?.dataSets?.[0] };
}

/** Series dimension ids in key order, with the codes present in this message. */
export function sdmxDimensions(json: any) {
  const { structure } = sdmxParts(json);
  return ((structure?.dimensions?.series ?? []) as any[]).map((d) => ({ id: d.id as string, name: d.name as string, codes: (d.values ?? []).map(label) as string[] }));
}

export function flattenSdmx(json: any, opts: { maxObs: number; keepAttributes?: string[] }): SdmxSeries[] {
  const { structure: st, dataSet: ds } = sdmxParts(json);
  if (!st || !ds?.series) return [];
  const dims: any[] = st.dimensions?.series ?? [];
  const attrs: any[] = st.attributes?.series ?? [];
  const times: any[] = st.dimensions?.observation?.[0]?.values ?? [];
  const keep = opts.keepAttributes && new Set(opts.keepAttributes);

  return Object.entries<any>(ds.series).map(([k, s]) => {
    const idx = k.split(":").map(Number);
    const codes = dims.map((d, i) => d.values?.[idx[i]]);
    const attributes: Record<string, string | undefined> = {};
    (s.attributes ?? []).forEach((ai: number | null, i: number) => {
      const a = attrs[i];
      if (ai == null || !a || (keep && !keep.has(a.id))) return;
      const v = a.values?.[ai];
      attributes[a.id] = v?.name ?? v?.id;
    });
    const obs = Object.entries<any>(s.observations ?? {})
      .map(([t, v]) => ({ period: String(times[Number(t)]?.id), value: v?.[0] == null ? null : Number(v[0]) }))
      .sort((a, b) => a.period.localeCompare(b.period));
    return {
      key: codes.map((c) => c?.id).join("."),
      dimensions: Object.fromEntries(dims.map((d, i) => [d.id, label(codes[i])])),
      attributes,
      observations: obs.slice(-opts.maxObs),
      totalObservations: obs.length,
    };
  });
}
