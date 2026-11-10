import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { TableScroll } from '../components/TableScroll';
import { api, ApiError, download, type Project, type Stats, type Task, type User } from '../api';
import { useAuth } from '../auth';

type Tab = 'review' | 'tasks' | 'insights';

export function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(user?.role === 'viewer' ? 'insights' : 'review');

  useEffect(() => {
    api<{ project: Project }>(`/projects/${id}`)
      .then((r) => setProject(r.project))
      .catch((e: Error) => setError(e.message));
  }, [id]);

  if (error)
    return (
      <main className="page">
        <p role="alert" className="error">
          {error}
        </p>
        <Link to="/">Back to projects</Link>
      </main>
    );
  if (!project || !id) return <p className="center muted">Loading…</p>;

  const tabs: [Tab, string][] = [
    ...(user?.role === 'viewer' ? [] : ([['review', 'Review']] as [Tab, string][])),
    ['tasks', 'Tasks'],
    ['insights', 'Insights'],
  ];

  return (
    <main className="page">
      <p>
        <Link to="/">← All projects</Link>
      </p>
      <h1>{project.name}</h1>
      {project.description && <p className="muted">{project.description}</p>}
      {project.rubric && (
        <details className="rubric">
          <summary>Rubric</summary>
          <p>{project.rubric}</p>
        </details>
      )}
      <div role="tablist" className="tabs">
        {tabs.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'review' && <ReviewPanel projectId={id} />}
      {tab === 'tasks' && <TasksPanel projectId={id} isAdmin={user?.role === 'admin'} />}
      {tab === 'insights' && <InsightsPanel project={project} canExport={user?.role !== 'reviewer'} />}
    </main>
  );
}

// ---------------------------------------------------------------- review

function ReviewPanel({ projectId }: { projectId: string }) {
  const [task, setTask] = useState<Task | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [rating, setRating] = useState(0);
  const [verdict, setVerdict] = useState<'pass' | 'fail' | 'unsure' | ''>('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(0);

  const next = useCallback(async () => {
    setState('loading');
    setRating(0);
    setVerdict('');
    setNotes('');
    try {
      const r = await api<{ task: Task }>(`/projects/${projectId}/next-task`);
      setTask(r.task);
      setState('ready');
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setState('empty');
      else {
        setError(e instanceof Error ? e.message : 'Error');
        setState('error');
      }
    }
  }, [projectId]);

  useEffect(() => {
    void next();
  }, [next]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!task) return;
    setError(null);
    if (!rating || !verdict) {
      setError('Choose a rating and a verdict before submitting.');
      return;
    }
    try {
      await api(`/tasks/${task.id}/reviews`, { method: 'POST', body: { rating, verdict, notes } });
      setSubmitted((n) => n + 1);
      await next();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your review');
    }
  }

  if (state === 'loading') return <p className="muted">Loading next task…</p>;
  if (state === 'error')
    return (
      <p role="alert" className="error">
        {error}
      </p>
    );
  if (state === 'empty')
    return (
      <div className="card" data-testid="all-done">
        <h2>You are all caught up</h2>
        <p className="muted">
          {submitted > 0 ? `You reviewed ${submitted} task${submitted === 1 ? '' : 's'} this session. ` : ''}
          There are no more tasks waiting for you in this project.
        </p>
      </div>
    );
  if (!task) return null;

  return (
    <form onSubmit={submit} className="review" aria-label="Review task">
      <section className="card">
        <h3>Prompt</h3>
        <p className="pre" data-testid="task-prompt">
          {task.prompt}
        </p>
      </section>
      <section className="card">
        <h3>AI response</h3>
        <p className="pre" data-testid="task-response">
          {task.response}
        </p>
      </section>
      <fieldset>
        <legend>Verdict</legend>
        {(['pass', 'fail', 'unsure'] as const).map((v) => (
          <label key={v} className="choice">
            <input type="radio" name="verdict" value={v} checked={verdict === v} onChange={() => setVerdict(v)} /> {v}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Quality rating</legend>
        {[1, 2, 3, 4, 5].map((n) => (
          <label key={n} className="choice">
            <input type="radio" name="rating" value={n} checked={rating === n} onChange={() => setRating(n)} /> {n}
          </label>
        ))}
      </fieldset>
      <label>
        Notes (why did you decide this?)
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={5000} />
      </label>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button type="submit">Submit review</button>
    </form>
  );
}

// ---------------------------------------------------------------- tasks

function TasksPanel({ projectId, isAdmin }: { projectId: string; isAdmin: boolean }) {
  const [items, setItems] = useState<Task[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [users, setUsers] = useState<User[]>([]);
  const [prompt, setPrompt] = useState('');
  const [response, setResponse] = useState('');
  const [bulk, setBulk] = useState('');
  const [error, setError] = useState<string | null>(null);
  const pageSize = 10;

  const load = useCallback(async () => {
    const q = new URLSearchParams({ page: String(page), pageSize: String(pageSize), ...(status ? { status } : {}) });
    const r = await api<{ items: Task[]; total: number }>(`/projects/${projectId}/tasks?${q}`);
    setItems(r.items);
    setTotal(r.total);
  }, [projectId, page, status]);

  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, [load]);

  useEffect(() => {
    if (isAdmin) api<{ items: User[] }>('/users').then((r) => setUsers(r.items)).catch(() => undefined);
  }, [isAdmin]);

  async function add(tasks: { prompt: string; response: string }[]) {
    setError(null);
    try {
      await api(`/projects/${projectId}/tasks`, { method: 'POST', body: { tasks } });
      setPrompt('');
      setResponse('');
      setBulk('');
      setPage(1);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? (e.details?.map((d) => `${d.field}: ${d.message}`).join('; ') ?? e.message) : 'Could not add tasks');
    }
  }

  async function addBulk(e: FormEvent) {
    e.preventDefault();
    try {
      const parsed = JSON.parse(bulk) as { prompt: string; response: string }[];
      await add(parsed);
    } catch {
      setError('Paste a JSON list like [{"prompt": "...", "response": "..."}]');
    }
  }

  async function assign(taskId: string, assigneeId: string) {
    await api(`/tasks/${taskId}`, { method: 'PATCH', body: { assigneeId: assigneeId || null } });
    await load();
  }

  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <section>
      <div className="row">
        <label className="inline">
          Status
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All</option>
            <option value="open">Open</option>
            <option value="in_review">In review</option>
            <option value="done">Done</option>
          </select>
        </label>
        <span className="muted">{total} tasks</span>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <TableScroll label="Tasks">
      <table>
        <thead>
          <tr>
            <th>Prompt</th>
            <th>Status</th>
            <th>Reviews</th>
            {isAdmin && <th>Assigned to</th>}
          </tr>
        </thead>
        <tbody>
          {items.map((t) => (
            <tr key={t.id}>
              <td className="clip">{t.prompt}</td>
              <td>
                <span className={`badge ${t.status}`}>{t.status.replace('_', ' ')}</span>
              </td>
              <td>{t.reviewCount}</td>
              {isAdmin && (
                <td>
                  <select aria-label={`Assign task ${t.prompt}`} value={t.assigneeId ?? ''} onChange={(e) => void assign(t.id, e.target.value)}>
                    <option value="">Anyone</option>
                    {users
                      .filter((u) => u.role !== 'viewer')
                      .map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                  </select>
                </td>
              )}
            </tr>
          ))}
          {items.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                No tasks yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
</TableScroll>
      <div className="row">
        <button className="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>
          Previous
        </button>
        <span>
          Page {page} of {pages}
        </span>
        <button className="ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>
          Next
        </button>
      </div>

      {isAdmin && (
        <>
          <form
            className="card form"
            aria-label="Add task"
            onSubmit={(e) => {
              e.preventDefault();
              void add([{ prompt, response }]);
            }}
          >
            <h3>Add a task</h3>
            <label>
              Prompt
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} required />
            </label>
            <label>
              AI response to rate
              <textarea value={response} onChange={(e) => setResponse(e.target.value)} rows={3} required />
            </label>
            <button type="submit">Add task</button>
          </form>
          <form className="card form" aria-label="Import tasks" onSubmit={addBulk}>
            <h3>Import many tasks</h3>
            <label>
              JSON list (up to 100)
              <textarea value={bulk} onChange={(e) => setBulk(e.target.value)} rows={4} placeholder='[{"prompt": "...", "response": "..."}]' />
            </label>
            <button type="submit">Import</button>
          </form>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- insights

function InsightsPanel({ project, canExport }: { project: Project; canExport: boolean }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Stats>(`/projects/${project.id}/stats`).then(setStats).catch((e: Error) => setError(e.message));
  }, [project.id]);

  if (error)
    return (
      <p role="alert" className="error">
        {error}
      </p>
    );
  if (!stats) return <p className="muted">Loading…</p>;
  const v = stats.reviews.verdicts;
  return (
    <section>
      <div className="stats">
        <Stat label="Tasks done" value={`${stats.tasks.done} / ${stats.tasks.total}`} />
        <Stat label="Reviews" value={String(stats.reviews.total)} />
        <Stat label="Average rating" value={stats.reviews.averageRating?.toFixed(2) ?? 'n/a'} />
        <Stat label="Pass / fail / unsure" value={`${v.pass} / ${v.fail} / ${v.unsure}`} />
        <Stat label="Agreement (kappa)" value={stats.agreement.averageKappa?.toFixed(2) ?? 'n/a'} testId="kappa" />
      </div>
      <p className="muted" data-testid="kappa-meaning">
        Reviewer agreement: {stats.agreement.interpretation}.
      </p>
      {stats.agreement.pairs.length > 0 && (
        <TableScroll label="Agreement between reviewers">
        <table>
          <caption>Agreement between reviewers</caption>
          <thead>
            <tr>
              <th>Reviewer A</th>
              <th>Reviewer B</th>
              <th>Shared tasks</th>
              <th>Agree</th>
              <th>Kappa</th>
            </tr>
          </thead>
          <tbody>
            {stats.agreement.pairs.map((p) => (
              <tr key={`${p.reviewerA}-${p.reviewerB}`}>
                <td>{p.reviewerA}</td>
                <td>{p.reviewerB}</td>
                <td>{p.sharedTasks}</td>
                <td>{p.percentAgreement}%</td>
                <td>{p.kappa?.toFixed(2) ?? 'n/a'}</td>
              </tr>
            ))}
          </tbody>
        </table>
</TableScroll>
      )}
      {canExport && (
        <button className="ghost" onClick={() => void download(`/projects/${project.id}/export.csv`, `${project.name}-reviews.csv`)}>
          Download CSV
        </button>
      )}
    </section>
  );
}

function Stat({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="stat card">
      <small className="muted">{label}</small>
      <strong data-testid={testId}>{value}</strong>
    </div>
  );
}
