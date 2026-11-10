import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { AuthProvider } from '../src/auth';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function renderApp(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('sign in screen', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sends signed-out visitors to the sign in page', async () => {
    fetchMock.mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHORIZED', message: 'No session' } }));
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('shows the server error when the password is wrong', async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHORIZED', message: 'No session' } }))
      .mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHORIZED', message: 'Incorrect email or password' } }));
    renderApp('/login');
    await userEvent.type(await screen.findByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong-password-1');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect email or password');
  });

  it('shows field errors on registration', async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHORIZED', message: 'No session' } }))
      .mockResolvedValueOnce(
        json(400, {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Some fields are invalid',
            details: [{ field: 'password', message: 'Password must be at least 10 characters' }],
          },
        }),
      );
    renderApp('/login');
    await userEvent.click(await screen.findByRole('button', { name: /create an account/i }));
    await userEvent.type(screen.getByLabelText('Name'), 'Ada');
    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText(/^Password/), 'short');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(screen.getAllByText('Password must be at least 10 characters').length).toBeGreaterThan(0));
  });

  it('shows every message when one field breaks several rules', async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHORIZED', message: 'No session' } }))
      .mockResolvedValueOnce(
        json(400, {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Some fields are invalid',
            details: [
              { field: 'password', message: 'Password must be at least 10 characters' },
              { field: 'password', message: 'Password must contain a letter and a number' },
            ],
          },
        }),
      );
    renderApp('/login');
    await userEvent.click(await screen.findByRole('button', { name: /create an account/i }));
    await userEvent.type(screen.getByLabelText('Name'), 'Ada');
    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText(/^Password/), 'short');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    const msg = await screen.findByText(/at least 10 characters.*letter and a number/);
    expect(msg).toBeInTheDocument();
  });

  it('shows the app once a session exists', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { accessToken: 't', user: { id: '1', email: 'ada@example.com', name: 'Ada', role: 'admin' } }))
      .mockResolvedValueOnce(json(200, { items: [] }));
    renderApp('/');
    expect(await screen.findByTestId('current-user')).toHaveTextContent('Ada');
    expect(await screen.findByRole('form', { name: 'Create project' })).toBeInTheDocument();
  });

  it('hides admin tools from reviewers', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { accessToken: 't', user: { id: '2', email: 'r@example.com', name: 'Rita', role: 'reviewer' } }))
      .mockResolvedValueOnce(json(200, { items: [] }));
    renderApp('/');
    await screen.findByTestId('current-user');
    expect(screen.queryByRole('form', { name: 'Create project' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Team' })).not.toBeInTheDocument();
  });
});
