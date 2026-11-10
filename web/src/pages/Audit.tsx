import { useEffect, useState } from 'react';
import { TableScroll } from '../components/TableScroll';
import { api } from '../api';

interface Entry {
  id: number;
  action: string;
  entity: string;
  entityId: string | null;
  actorEmail: string | null;
  createdAt: string;
}

export function AuditPage() {
  const [items, setItems] = useState<Entry[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ items: Entry[] }>('/audit?limit=100')
      .then((r) => setItems(r.items))
      .catch((e: Error) => setError(e.message));
  }, []);
  return (
    <main className="page">
      <h1>Audit log</h1>
      <p className="muted">The latest 100 actions: who did what, and when.</p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <TableScroll label="Audit log entries">
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Who</th>
            <th>Action</th>
            <th>Item</th>
          </tr>
        </thead>
        <tbody>
          {items.map((a) => (
            <tr key={a.id}>
              <td>{new Date(a.createdAt).toLocaleString()}</td>
              <td>{a.actorEmail ?? 'system'}</td>
              <td>{a.action}</td>
              <td>{a.entity}</td>
            </tr>
          ))}
        </tbody>
      </table>
</TableScroll>
    </main>
  );
}
