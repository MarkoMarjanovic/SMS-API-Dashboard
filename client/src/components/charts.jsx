import { useEffect, useMemo, useState } from 'react';
import {
  Chart as ChartJS, BarController, BarElement, LineController, LineElement, PointElement, CategoryScale, LinearScale, Tooltip, Filler,
} from 'chart.js';
import { Chart } from 'react-chartjs-2';
import { ChoroplethController, GeoFeature, ColorScale, ProjectionScale, topojson } from 'chartjs-chart-geo';
import world from 'world-atlas/countries-110m.json';
import { PRODUCTS } from '@shared/products.js';
import { alpha2ToNumeric, numericToAlpha2, countryName, dateShort, flag } from '../format.js';

ChartJS.register(BarController, BarElement, LineController, LineElement, PointElement, CategoryScale, LinearScale, Tooltip, Filler,
  ChoroplethController, GeoFeature, ColorScale, ProjectionScale);

const FEATURES = topojson.feature(world, world.objects.countries).features.filter((f) => f.properties.name !== 'Antarctica');

/** Reads chart colours from CSS tokens and updates when the theme changes. */
export function useChartColors() {
  const read = () => {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    return {
      series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => v(`--s${i}`)),
      seq: [0, 1, 2, 3, 4, 5, 6].map((i) => v(`--seq-${i}`)),
      text: v('--text'), text2: v('--text-2'), muted: v('--muted'), grid: v('--grid'), axis: v('--axis'), surface: v('--surface'), surface2: v('--surface-2'),
      critical: v('--critical'),
    };
  };
  const [c, setC] = useState(read);
  useEffect(() => {
    const update = () => setC(read());
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', update);
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => { mq.removeEventListener('change', update); mo.disconnect(); };
  }, []);
  return c;
}

export const productColor = (c, product) => c.series[((PRODUCTS[product]?.color || 8) - 1) % 8];

function baseOptions(c, fmt) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 250 },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: c.surface, titleColor: c.text, bodyColor: c.text2, footerColor: c.text, borderColor: c.axis, borderWidth: 1,
        padding: 10, boxPadding: 4, usePointStyle: true,
        callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${fmt(ctx.parsed.y ?? ctx.parsed.x)}` },
      },
    },
    scales: {
      x: { grid: { display: false }, border: { color: c.axis }, ticks: { color: c.muted, maxRotation: 0, autoSkipPadding: 16 } },
      y: { grid: { color: c.grid }, border: { display: false }, ticks: { color: c.muted, callback: (v) => fmt(v, true) }, beginAtZero: true },
    },
  };
}

/** Legend that doubles as a series toggle. */
export function Legend({ items, hidden, onToggle }) {
  return (
    <div className="legend" role="group" aria-label="Series">
      {items.map((it) => (
        <span key={it.key} className={hidden?.has(it.key) ? 'off' : ''} onClick={() => onToggle?.(it.key)} role="button" tabIndex={0}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onToggle?.(it.key)} aria-pressed={!hidden?.has(it.key)}>
          <i style={{ background: it.color }} />{it.label}
        </span>
      ))}
    </div>
  );
}

/**
 * Stacked bars (or lines) over time.
 * series: [{ key, label, color, data: number[] }]
 */
export function TimeChart({ periods, series, type = 'bar', stacked = true, fmt = (v) => v, height = '', group = 'day' }) {
  const c = useChartColors();
  const [hidden, setHidden] = useState(new Set());
  const toggle = (k) => setHidden((h) => { const n = new Set(h); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const visible = series.filter((s) => !hidden.has(s.key));
  const labels = periods.map((p) => (group === 'week' ? 'Wk of ' + dateShort(p) : dateShort(p)));
  const options = useMemo(() => {
    const o = baseOptions(c, fmt);
    o.scales.x.stacked = stacked;
    o.scales.y.stacked = stacked;
    if (stacked && visible.length > 1) o.plugins.tooltip.callbacks.footer = (items) => `Total: ${fmt(items.reduce((a, i) => a + (i.parsed.y || 0), 0))}`;
    return o;
  }, [c, stacked, visible.length]);
  const data = {
    labels,
    datasets: visible.map((s) => type === 'bar'
      ? { label: s.label, data: s.data, backgroundColor: s.color, borderColor: c.surface, borderWidth: stacked ? { top: 2 } : 0, borderSkipped: 'start', borderRadius: 3, maxBarThickness: 28 }
      : { type: 'line', label: s.label, data: s.data, borderColor: s.color, backgroundColor: s.color, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointHoverBorderColor: c.surface, pointHoverBorderWidth: 2, tension: 0.25 }),
  };
  return (
    <div className="stack" style={{ gap: 10 }}>
      {series.length > 1 && <Legend items={series} hidden={hidden} onToggle={toggle} />}
      <div className={`chart-box ${height}`}><Chart type={type} data={data} options={options} /></div>
    </div>
  );
}

/** Horizontal bars for ranked categories. rows: [{ label, value, color? }] */
export function HBar({ rows, fmt = (v) => v, height = 260, color }) {
  const c = useChartColors();
  const options = useMemo(() => {
    const o = baseOptions(c, fmt);
    o.indexAxis = 'y';
    o.interaction = { mode: 'nearest', intersect: true, axis: 'y' };
    o.plugins.tooltip.callbacks.label = (ctx) => ` ${fmt(ctx.parsed.x)}`;
    o.scales = {
      x: { grid: { color: c.grid }, border: { display: false }, ticks: { color: c.muted, callback: (v) => fmt(v, true) }, beginAtZero: true },
      y: { grid: { display: false }, border: { color: c.axis }, ticks: { color: c.text2 } },
    };
    return o;
  }, [c]);
  const data = {
    labels: rows.map((r) => r.label),
    datasets: [{ data: rows.map((r) => r.value), backgroundColor: rows.map((r) => r.color || color || c.series[0]), borderRadius: 4, borderSkipped: 'start', barThickness: 14 }],
  };
  return <div className="chart-box" style={{ height }}><Chart type="bar" data={data} options={options} /></div>;
}

/** Choropleth of a metric by ISO alpha-2 country. values: { US: 123.4, ... } */
export function WorldMap({ values, fmt = (v) => v, onSelect, label = 'Spend' }) {
  const c = useChartColors();
  const byNumeric = useMemo(() => {
    const m = new Map();
    for (const [cc, v] of Object.entries(values)) {
      const n = alpha2ToNumeric(cc);
      if (n) m.set(String(n), v);
    }
    return m;
  }, [values]);
  const max = Math.max(1e-9, ...Object.values(values));
  const ramp = c.seq.slice(1);
  const data = {
    labels: FEATURES.map((f) => f.properties.name),
    datasets: [{
      label,
      outline: FEATURES,
      data: FEATURES.map((f) => {
        const v = byNumeric.get(String(f.id));
        // sqrt scale so the largest market doesn't wash out the rest
        return { feature: f, value: v ? Math.sqrt(v / max) : null };
      }),
      borderColor: c.surface,
      borderWidth: 0.6,
      hoverBorderColor: c.text,
      hoverBorderWidth: 1.2,
    }],
  };
  const options = {
    responsive: true, maintainAspectRatio: false, animation: false,
    showOutline: false, showGraticule: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: c.surface, titleColor: c.text, bodyColor: c.text2, borderColor: c.axis, borderWidth: 1, padding: 10,
        callbacks: {
          title: (items) => {
            const f = items[0].raw.feature;
            const cc = numericToAlpha2(String(f.id).padStart(3, '0'));
            return `${flag(cc)} ${cc ? countryName(cc) : f.properties.name}`;
          },
          label: (ctx) => {
            const v = byNumeric.get(String(ctx.raw.feature.id));
            return v ? ` ${label}: ${fmt(v)}` : ' No traffic';
          },
        },
      },
    },
    scales: {
      projection: { axis: 'x', projection: 'equalEarth' },
      color: {
        axis: 'x', display: false, missing: c.surface2,
        interpolate: (t) => ramp[Math.min(ramp.length - 1, Math.floor(t * ramp.length))],
      },
    },
    onClick: (_e, els) => {
      if (!els.length || !onSelect) return;
      const f = data.datasets[0].data[els[0].index].feature;
      const cc = numericToAlpha2(String(f.id).padStart(3, '0'));
      if (cc && values[cc]) onSelect(cc);
    },
  };
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="map-box"><Chart type="choropleth" data={data} options={options} /></div>
      <div className="seq-legend"><span>Less</span><span className="ramp">{ramp.map((x) => <i key={x} style={{ background: x }} />)}</span><span>More {label.toLowerCase()}</span></div>
    </div>
  );
}
