import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type Project } from '../api';
import { useAuth } from '../auth';

export function ProjectsPage() {
  const { user } = useAuth();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [rubric, setRubric] = useState('');
  const [requiredReviews, setRequiredReviews] = useState(2);
  const [formError, setFormError] = useState<string | null>(null);

  async function load() {
    try {
      setProjects((await api<{ items: Project[] }>('/projects')).items);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load projects');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    try {
      await api('/projects', { method: 'POST', body: { name, description, rubric, requiredReviews } });
      setName('');
      setDescription('');
      setRubric('');
      await load();
    } catch (err) {
      setFormError(err instanceof ApiError ? (err.details?.map((d) => d.message).join(', ') ?? err.message) : 'Could not create project');
    }
  }

  return (
    <main className="page">
      <h1>Projects</h1>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!projects && !error && <p className="muted">Loading…</p>}
      {projects && projects.length === 0 && (
        <p className="muted">
          No projects yet.{user?.role === 'admin' ? ' Create the first one below.' : ' An administrator needs to create one.'}
        </p>
      )}
      <ul className="grid" aria-label="Projects">
        {projects?.map((p) => {
          const pct = p.taskCount ? Math.round(((p.doneCount ?? 0) / p.taskCount) * 100) : 0;
          return (
            <li key={p.id} className="card">
              <h3>
                <Link to={`/projects/${p.id}`}>{p.name}</Link>
              </h3>
              <p className="muted">{p.description || 'No description'}</p>
              <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${p.name} progress`}>
                <span style={{ width: `${pct}%` }} />
              </div>
              <small className="muted">
                {p.doneCount ?? 0} of {p.taskCount ?? 0} tasks done · {p.requiredReviews} reviews each
              </small>
            </li>
          );
        })}
      </ul>

      {user?.role === 'admin' && (
        <form className="card form" onSubmit={create} aria-label="Create project">
          <h2>New project</h2>
          <label>
            Project name
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
          </label>
          <label>
            Description
            <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
          </label>
          <label>
            Rubric (what counts as pass or fail)
            <textarea value={rubric} onChange={(e) => setRubric(e.target.value)} rows={3} maxLength={5000} />
          </label>
          <label>
            Reviews needed per task
            <input
              type="number"
              min={1}
              max={10}
              value={requiredReviews}
              onChange={(e) => setRequiredReviews(Number(e.target.value))}
            />
          </label>
          {formError && (
            <p role="alert" className="error">
              {formError}
            </p>
          )}
          <button type="submit">Create project</button>
        </form>
      )}
    </main>
  );
}
