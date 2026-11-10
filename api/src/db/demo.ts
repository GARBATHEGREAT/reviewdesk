import bcrypt from 'bcryptjs';
import type pg from 'pg';

export const DEMO_PASSWORD = 'ReviewDesk2024';

const tasks: [string, string][] = [
  ['What is the capital of Australia?', 'The capital of Australia is Sydney.'],
  ['What is the capital of Australia?', 'The capital of Australia is Canberra.'],
  ['Explain what a hash map is in one sentence.', 'A hash map stores key-value pairs and finds a value quickly by hashing its key.'],
  ['Write a Python function that returns the largest number in a list.', 'def largest(xs):\n    return sorted(xs)[0]'],
  ['Write a Python function that returns the largest number in a list.', 'def largest(xs):\n    return max(xs)'],
  ['Is it safe to store passwords in plain text?', 'Yes, as long as the database is private.'],
  ['Summarise: "The meeting moved from Monday to Wednesday at 3pm."', 'The meeting is now on Wednesday at 3pm.'],
  ['How many days are in a leap year?', 'A leap year has 366 days.'],
  ['Translate "good morning" into French.', 'Bonne nuit.'],
  ['What does HTTP status 404 mean?', 'The server could not find the requested resource.'],
];

const users: [string, string, string][] = [
  ['admin@reviewdesk.dev', 'Ada Admin', 'admin'],
  ['rita@reviewdesk.dev', 'Rita Reviewer', 'reviewer'],
  ['ravi@reviewdesk.dev', 'Ravi Reviewer', 'reviewer'],
];

/**
 * Demo data: one admin, two reviewers, and a project with ten AI answers to rate.
 * Safe to run many times: existing accounts and the demo project are left alone.
 */
export async function seedDemo(pool: pg.Pool, bcryptRounds: number): Promise<void> {
  const hash = await bcrypt.hash(DEMO_PASSWORD, bcryptRounds);
  let adminId = '';
  for (const [email, name, role] of users) {
    const { rows } = await pool.query(
      `INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, $4)
       ON CONFLICT ((lower(email))) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [email, name, hash, role],
    );
    if (role === 'admin') adminId = rows[0].id;
  }
  const existing = await pool.query("SELECT id FROM projects WHERE name = 'Fact and code check (demo)'");
  if (existing.rows[0]) return;
  const { rows } = await pool.query(
    `INSERT INTO projects (name, description, rubric, required_reviews, created_by)
     VALUES ('Fact and code check (demo)', 'Rate AI answers for factual and technical correctness.',
             'Pass = fully correct. Fail = contains a wrong fact or a bug. Unsure = cannot verify. Rate 1-5 for clarity.', 2, $1)
     RETURNING id`,
    [adminId],
  );
  for (const [prompt, response] of tasks) {
    await pool.query('INSERT INTO tasks (project_id, prompt, response) VALUES ($1, $2, $3)', [rows[0].id, prompt, response]);
  }
}
