"use client";

import { useState, useEffect, useMemo } from "react";
import PropTypes from "prop-types";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import Card from "@/shared/components/Card";
import { fmtCost } from "@/shared/utils/currency";

const fmtTokens = (n) => {
  if (n >= 1000000000) return `${(n / 1000000000).toFixed(1)}B`;
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n || 0);
};

const fmtChartCost = (n) => fmtCost(n, 4);

// Family series palette (by legend order); "other" always renders gray.
const FAMILY_COLORS = ["#6366f1", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#06b6d4", "#f43f5e", "#84cc16"];
const OTHER_COLOR = "#64748b";

const familyColor = (family, idx) =>
  family === "other" ? OTHER_COLOR : FAMILY_COLORS[idx % FAMILY_COLORS.length] || OTHER_COLOR;

export default function UsageChart({ period = "7d" }) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState("tokens");

  // No setLoading(true): state starts true; period changes re-fetch with the
  // fresh result (inline IIFE mirrors UsageDashboard — a named callback that
  // sets state trips react-hooks/set-state-in-effect when called from here).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/usage/chart?period=${period}`);
        if (res.ok) {
          const json = await res.json();
          if (!cancelled) setData(json);
        }
      } catch (e) {
        console.error("Failed to fetch chart data:", e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [period]);

  // Model families ordered by period total (server already folded the tail
  // into "other"); rows are flattened so recharts stackId handles the layers.
  const modelFamilies = useMemo(() => {
    const totals = {};
    for (const d of data) {
      for (const [f, t] of Object.entries(d.byModel || {})) totals[f] = (totals[f] || 0) + t;
    }
    return Object.keys(totals).sort((a, b) => totals[b] - totals[a]);
  }, [data]);

  // Display cap: at most 6 series in BOTH the chart and the header legend, so
  // every plotted color has a named entry and nothing is silently unexplained.
  // "other" (the aggregate) always keeps one slot; the dropped tail is folded
  // back into it client-side so the plotted totals still match the data.
  const MAX_LEGEND_SERIES = 6;
  const displayedFamilies = useMemo(() => {
    const hasOther = modelFamilies.includes("other");
    const named = modelFamilies.filter((f) => f !== "other");
    const top = named.slice(0, hasOther ? MAX_LEGEND_SERIES - 1 : MAX_LEGEND_SERIES);
    return hasOther ? [...top, "other"] : top;
  }, [modelFamilies]);

  const modelData = useMemo(() => {
    const shown = new Set(displayedFamilies);
    const named = displayedFamilies.filter((f) => f !== "other");
    const keepOther = displayedFamilies.includes("other");
    const rows = data.map((d) => {
      const src = d.byModel || {};
      const row = { label: d.label };
      for (const f of named) row[f] = typeof src[f] === "number" ? src[f] : 0;
      if (keepOther) {
        let agg = typeof src.other === "number" ? src.other : 0;
        for (const [k, v] of Object.entries(src)) {
          if (!shown.has(k)) agg += typeof v === "number" ? v : 0;
        }
        row.other = agg;
      }
      return row;
    });
    // Bucket gaps are filled with real 0s — ALWAYS, including interior gaps.
    // A family that ran at 02:00 and again at 18:00 was simply idle in between;
    // drawing one straight connector across those 15 silent hours renders as a
    // hard diagonal that reads as sustained traffic (worse: monotone smoothing
    // has no interior points to bend on, so it looks like a sharp polyline).
    // Zero-filling every gap makes idle time visibly idle and leaves the
    // smoothing to shape runs of real samples.
    for (const f of displayedFamilies) {
      for (let i = 0; i < rows.length; i++) {
        if (typeof rows[i][f] !== "number") rows[i][f] = 0;
      }
    }
    return rows;
  }, [data, displayedFamilies]);

  const hasData =
    viewMode === "models"
      ? displayedFamilies.length > 0
      : data.some((d) => d.tokens > 0 || d.cost > 0);

  const MODES = [
    { key: "tokens", label: "Tokens" },
    { key: "cost", label: "Cost" },
    { key: "models", label: "Model Type" },
  ];

  return (
    <Card className="flex min-w-0 flex-col gap-3 p-3 sm:p-4">
      {/* Top row: mode tabs on the left, the Model Type legend pinned to the
          container's right edge (only in the Model Type view). The chart's own
          <Legend> renders below the plot and wastes a row, so the legend is
          hand-built here — same colors via familyColor(), so both stay in sync.

          Responsive: on narrow screens the tabs already eat most of line 1, so
          squeezing 6 legend items into the leftover width stacks them into a
          tall column. `w-full` forces the legend onto its OWN row below the
          tabs (left-aligned, free to wrap); from `sm` up it shrinks back to
          content width and hugs the right edge (`sm:w-auto sm:justify-end`). */}
      <div className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="grid grid-cols-3 items-center gap-1 rounded-lg border border-border bg-bg-alt p-1 sm:w-auto">
          {MODES.map((m) => (
            <button
              key={m.key}
              onClick={() => setViewMode(m.key)}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${viewMode === m.key ? "bg-primary text-white shadow-sm" : "text-text-muted hover:text-text hover:bg-surface-2"}`}
            >
              {m.label}
            </button>
          ))}
        </div>

        {viewMode === "models" && displayedFamilies.length > 0 && (
          <div className="flex w-full min-w-0 flex-wrap items-center justify-start gap-x-3 gap-y-1.5 text-[11px] leading-none text-text-muted sm:w-auto sm:justify-end sm:gap-y-1 sm:pr-3">
            {displayedFamilies.map((f, i) => (
              <span key={f} className="flex items-center gap-1.5 whitespace-nowrap">
                <span
                  className="inline-block size-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: familyColor(f, i) }}
                />
                {f}
              </span>
            ))}
          </div>
        )}
      </div>

      {loading ? (
        <div className="h-48 flex items-center justify-center text-text-muted text-sm">Loading...</div>
      ) : !hasData ? (
        <div className="h-48 flex items-center justify-center text-text-muted text-sm">No data for this period</div>
      ) : viewMode === "models" ? (
        <ResponsiveContainer width="100%" height={264}>
          <AreaChart data={modelData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            {/* Same soft vertical-fade fill as the Tokens/Cost curves, one
                gradient per family color. */}
            <defs>
              {displayedFamilies.map((f, i) => (
                <linearGradient key={f} id={`gradFam-${i}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={familyColor(f, i)} stopOpacity={0.25} />
                  <stop offset="95%" stopColor={familyColor(f, i)} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.1} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={fmtTokens}
              width={50}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--color-bg)",
                border: "1px solid var(--color-border)",
                borderRadius: "8px",
                fontSize: "12px",
              }}
              formatter={(value, name) => [fmtTokens(value), name]}
              itemSorter={(item) => -(Number(item.value) || 0)}
            />
            {/* Legend lives in the header row (see above) — no <Legend> here. */}
            {displayedFamilies.map((f, i) => (
              <Area
                key={f}
                type="monotone"
                dataKey={f}
                stroke={familyColor(f, i)}
                strokeWidth={2}
                fill={`url(#gradFam-${i})`}
                // No connectNulls: every bucket is a real number now (gaps are
                // zero-filled above), so the curve dives to the baseline during
                // idle hours instead of floating a connector over them.
                dot={false}
                activeDot={{ r: 4 }}
                name={f}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      ) : (
        <ResponsiveContainer width="100%" height={264}>
          <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="gradTokens" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#6366f1" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="gradCost" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.1} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={viewMode === "tokens" ? fmtTokens : fmtChartCost}
              width={50}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--color-bg)",
                border: "1px solid var(--color-border)",
                borderRadius: "8px",
                fontSize: "12px",
              }}
              formatter={(value, name) =>
                name === "tokens" ? [fmtTokens(value), "Tokens"] : [fmtChartCost(value), "Cost"]
              }
            />
            {viewMode === "tokens" ? (
              <Area
                type="monotone"
                dataKey="tokens"
                stroke="#6366f1"
                strokeWidth={2}
                fill="url(#gradTokens)"
                dot={false}
                activeDot={{ r: 4 }}
              />
            ) : (
              <Area
                type="monotone"
                dataKey="cost"
                stroke="#f59e0b"
                strokeWidth={2}
                fill="url(#gradCost)"
                dot={false}
                activeDot={{ r: 4 }}
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}

UsageChart.propTypes = {
  period: PropTypes.string,
};
