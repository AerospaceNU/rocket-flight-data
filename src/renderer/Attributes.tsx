import React, { useEffect, useState } from 'react';
import type { AttributeRow } from '../shared/types';

export function Attributes({
  flightId,
  altimeterId,
}: {
  flightId: string;
  altimeterId: string;
}) {
  const [rows, setRows] = useState<AttributeRow[]>([]);
  const [original, setOriginal] = useState<AttributeRow[]>([]);
  const [status, setStatus] = useState<{ kind: 'idle' | 'saving' | 'saved' | 'error'; text?: string }>({
    kind: 'idle',
  });

  useEffect(() => {
    window.api.getAttributes(flightId, altimeterId).then((rs) => {
      setRows(rs);
      setOriginal(rs);
      setStatus({ kind: 'idle' });
    });
  }, [flightId, altimeterId]);

  const dirty = JSON.stringify(rows) !== JSON.stringify(original);

  function setKey(i: number, key: string) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, key } : r)));
  }
  function setValue(i: number, value: string) {
    setRows((rs) =>
      rs.map((r, idx) =>
        idx === i ? { ...r, value, source: r.source === 'derived' ? 'user' : r.source || 'user' } : r
      )
    );
  }
  function remove(i: number) {
    setRows((rs) => rs.filter((_, idx) => idx !== i));
  }
  function add() {
    setRows((rs) => [...rs, { key: '', value: '', source: 'user' }]);
  }

  async function save() {
    setStatus({ kind: 'saving' });
    const res = await window.api.saveAttributes(flightId, altimeterId, rows);
    if (res.ok) {
      setOriginal(rows);
      setStatus({ kind: 'saved', text: 'Saved.' });
    } else {
      setStatus({ kind: 'error', text: res.error });
    }
  }

  function revert() {
    setRows(original);
    setStatus({ kind: 'idle' });
  }

  return (
    <div className="attrs-pane">
      <div className="attrs-grid">
        <div style={{ color: 'var(--text-dim)', fontSize: 11, textTransform: 'uppercase' }}>
          Key
        </div>
        <div style={{ color: 'var(--text-dim)', fontSize: 11, textTransform: 'uppercase' }}>
          Value
        </div>
        <div style={{ color: 'var(--text-dim)', fontSize: 11, textTransform: 'uppercase', textAlign: 'center' }}>
          Source
        </div>
        <div />
        {rows.map((r, i) => (
          <React.Fragment key={i}>
            <input value={r.key} onChange={(e) => setKey(i, e.target.value)} />
            <input value={r.value} onChange={(e) => setValue(i, e.target.value)} />
            <div className="source-tag">{r.source || '—'}</div>
            <button title="Delete" onClick={() => remove(i)}>
              ✕
            </button>
          </React.Fragment>
        ))}
      </div>
      <div className="attrs-actions">
        <button onClick={save} disabled={!dirty || status.kind === 'saving'}>
          {status.kind === 'saving' ? 'Saving…' : 'Save'}
        </button>
        <button className="secondary" onClick={revert} disabled={!dirty}>
          Revert
        </button>
        <button className="secondary" onClick={add}>
          + Add attribute
        </button>
        {status.kind !== 'idle' && (
          <span className={'status' + (status.kind === 'error' ? ' error' : '')}>
            {status.text}
          </span>
        )}
      </div>
    </div>
  );
}
