import { Link, Navigate, NavLink, Outlet, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import type { Role } from './api';
import { AuditPage } from './pages/Audit';
import { LoginPage } from './pages/Login';
import { ProjectPage } from './pages/Project';
import { ProjectsPage } from './pages/Projects';
import { UsersPage } from './pages/Users';

function RequireAuth({ roles }: { roles?: Role[] }) {
  const { user, loading } = useAuth();
  if (loading) return <p className="center muted">Loading…</p>;
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) {
    return (
      <main className="page">
        <h1>No access</h1>
        <p className="muted">Your role ({user.role}) cannot open this page.</p>
      </main>
    );
  }
  return <Outlet />;
}

function Shell() {
  const { user, logout } = useAuth();
  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">
          Review<span>Desk</span>
        </Link>
        <nav aria-label="Main">
          <NavLink to="/" end>
            Projects
          </NavLink>
          {user?.role === 'admin' && <NavLink to="/team">Team</NavLink>}
          {user?.role === 'admin' && <NavLink to="/audit">Audit log</NavLink>}
        </nav>
        <div className="who">
          <span data-testid="current-user">
            {user?.name} <em className="badge">{user?.role}</em>
          </span>
          <button className="ghost" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </header>
      <Outlet />
    </>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<Shell />}>
          <Route index element={<ProjectsPage />} />
          <Route path="projects/:id" element={<ProjectPage />} />
          <Route element={<RequireAuth roles={['admin']} />}>
            <Route path="team" element={<UsersPage />} />
            <Route path="audit" element={<AuditPage />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
