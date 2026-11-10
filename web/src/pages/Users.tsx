import { useEffect, useState } from 'react';
import { TableScroll } from '../components/TableScroll';
import { api, ApiError, type Role, type User } from '../api';
import { useAuth } from '../auth';

export function UsersPage() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<(User & { createdAt: string })[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setUsers((await api<{ items: (User & { createdAt: string })[] }>('/users')).items);
  }
  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, []);

  async function setRole(id: string, role: Role) {
    setError(null);
    try {
      await api(`/users/${id}/role`, { method: 'PATCH', body: { role } });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not change the role');
      await load();
    }
  }

  return (
    <main className="page">
      <h1>Team</h1>
      <p className="muted">Admins manage projects and people. Reviewers rate tasks. Viewers can read results and export.</p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <TableScroll label="Team members">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>
                {u.name} {u.id === me?.id && <em className="muted">(you)</em>}
              </td>
              <td>{u.email}</td>
              <td>
                <select aria-label={`Role for ${u.email}`} value={u.role} onChange={(e) => void setRole(u.id, e.target.value as Role)}>
                  <option value="admin">admin</option>
                  <option value="reviewer">reviewer</option>
                  <option value="viewer">viewer</option>
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
</TableScroll>
    </main>
  );
}
