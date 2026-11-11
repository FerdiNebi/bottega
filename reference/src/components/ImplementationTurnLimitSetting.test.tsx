import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const state = vi.hoisted(() => ({
  isAdmin: 1,
  refresh: vi.fn(),
  update: vi.fn(),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { is_admin: state.isAdmin } }),
}));

vi.mock('../contexts/AppSettingsContext', () => ({
  useAppSettings: () => ({ implementationMaxTurns: 150, refresh: state.refresh }),
}));

vi.mock('../utils/api', () => ({
  api: { appSettings: { update: state.update } },
}));

import ImplementationTurnLimitSetting from './ImplementationTurnLimitSetting';

beforeEach(() => {
  vi.clearAllMocks();
  state.isAdmin = 1;
  state.update.mockResolvedValue({ ok: true, json: async () => ({}) });
  state.refresh.mockResolvedValue(undefined);
});

describe('ImplementationTurnLimitSetting', () => {
  it('shows the current limit and saves a new one', async () => {
    render(<ImplementationTurnLimitSetting />);
    const input = screen.getByLabelText(/Maximum model turns/);
    expect(input).toHaveValue('150');

    fireEvent.change(input, { target: { value: '80' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByText('Saved.')).toBeInTheDocument());
    expect(state.update).toHaveBeenCalledWith({ implementation_max_turns: '80' });
    expect(state.refresh).toHaveBeenCalled();
  });

  it('labels 0 as no limit', () => {
    render(<ImplementationTurnLimitSetting />);
    fireEvent.change(screen.getByLabelText(/Maximum model turns/), { target: { value: '0' } });

    expect(screen.getByText('no limit')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('rejects input that is not a whole number in range', () => {
    render(<ImplementationTurnLimitSetting />);
    fireEvent.change(screen.getByLabelText(/Maximum model turns/), { target: { value: '12.5' } });

    expect(screen.getByText(/Enter a whole number from 0 to 10000/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('shows the server error when saving fails', async () => {
    state.update.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: 'nope' }) });
    render(<ImplementationTurnLimitSetting />);
    fireEvent.change(screen.getByLabelText(/Maximum model turns/), { target: { value: '90' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByText('nope')).toBeInTheDocument());
  });

  it('is read-only for non-admins', () => {
    state.isAdmin = 0;
    render(<ImplementationTurnLimitSetting />);

    expect(screen.getByLabelText(/Maximum model turns/)).toBeDisabled();
    expect(screen.getByText(/Admin access required/)).toBeInTheDocument();
  });
});
