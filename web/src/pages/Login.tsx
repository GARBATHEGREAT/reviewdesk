import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { ApiError } from '../api';
import { useAuth } from '../auth';

export function LoginPage() {
  const { user, login, register } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    setBusy(true);
    try {
      if (mode === 'login') await login(email, password);
      else await register(name, email, password);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        // A field can fail several rules at once: show every message, not just the last.
        const byField: Record<string, string[]> = {};
        for (const d of err.details ?? []) (byField[d.field] ??= []).push(d.message);
        setFieldErrors(Object.fromEntries(Object.entries(byField).map(([k, v]) => [k, v.join(' ')])));
      } else setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <h1 className="brand big">
        Review<span>Desk</span>
      </h1>
      <p className="muted">Rate AI answers with your team and measure how well you agree.</p>
      <form onSubmit={submit} className="card" aria-label={mode === 'login' ? 'Sign in' : 'Create account'} noValidate>
        <h2>{mode === 'login' ? 'Sign in' : 'Create your account'}</h2>
        {mode === 'register' && (
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
            {fieldErrors.name && <small className="error">{fieldErrors.name}</small>}
          </label>
        )}
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
          {fieldErrors.email && <small className="error">{fieldErrors.email}</small>}
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
          />
          {fieldErrors.password && <small className="error">{fieldErrors.password}</small>}
          {mode === 'register' && <small className="muted">At least 10 characters, with a letter and a number.</small>}
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
        <button
          type="button"
          className="link"
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login');
            setError(null);
            setFieldErrors({});
          }}
        >
          {mode === 'login' ? 'New here? Create an account' : 'Have an account? Sign in'}
        </button>
        {mode === 'register' && <p className="muted small">The first account created becomes the administrator.</p>}
      </form>
    </main>
  );
}
