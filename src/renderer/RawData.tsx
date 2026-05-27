import React, { useMemo, useState } from 'react';
import type { FlightData } from '../shared/types';

const PAGE_SIZE = 500;

export function RawData({ data }: { data: FlightData | null }) {
  const [page, setPage] = useState(0);

  const slice = useMemo(() => {
    if (!data) return { rows: [], start: 0, end: 0, total: 0 };
    const start = page * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, data.rows.length);
    return { rows: data.rows.slice(start, end), start, end, total: data.rows.length };
  }, [data, page]);

  if (!data) return <div className="placeholder">Loading…</div>;
  if (data.rows.length === 0)
    return <div className="placeholder">No rows in this file.</div>;

  const numPages = Math.max(1, Math.ceil(data.rows.length / PAGE_SIZE));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          padding: '6px 12px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          background: 'var(--bg-elev)',
        }}
      >
        <button
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          disabled={page === 0}
        >
          Prev
        </button>
        <span style={{ color: 'var(--text-dim)' }}>
          rows {slice.start + 1}–{slice.end} of {slice.total}
        </span>
        <button
          onClick={() => setPage((p) => Math.min(numPages - 1, p + 1))}
          disabled={page >= numPages - 1}
        >
          Next
        </button>
      </div>
      <div className="raw-table-wrap">
        <table className="raw-table">
          <thead>
            <tr>
              <th>#</th>
              {data.columns.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {slice.rows.map((row, ri) => (
              <tr key={ri + slice.start}>
                <td className="num" style={{ color: 'var(--text-dim)' }}>
                  {slice.start + ri}
                </td>
                {data.columns.map((_c, ci) => {
                  const v = row[ci];
                  const isNum = typeof v === 'number';
                  return (
                    <td key={ci} className={isNum ? 'num' : ''}>
                      {isNum
                        ? Number.isInteger(v)
                          ? String(v)
                          : (v as number).toPrecision(6)
                        : String(v ?? '')}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
