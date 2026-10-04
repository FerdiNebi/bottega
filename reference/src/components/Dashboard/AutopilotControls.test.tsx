import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { mockTypedResponse } from '../../test/typedResponse';
import type { AutopilotStatusResponse } from '../../../shared/api/projects';

vi.mock('../../utils/api', () => ({
  api: {
    projects: {
      getAutopilot: vi.fn(),
      setAutopilot: vi.fn(),
      startAutopilot: vi.fn(),
    },
  },
}));

vi.mock('lucide-react', () => ({
  Loader2: () => <span />,
  Play: () => <span />,
  Rocket: () => <span />,
}));

import { api } from '../../utils/api';
import AutopilotControls, { AUTOPILOT_POLL_MS, describeAutopilot } from './AutopilotControls';

function status(overrides: Partial<AutopilotStatusResponse> = {}): AutopilotStatusResponse {
  return {
    enabled: true,
    isGitRepository: true,
    running: null,
    next: { taskId: 4, title: '1. Scaffold' },
    readyCount: 2,
    waitingCount: 3,
    blockedCount: 0,
    message: null,
    ...overrides,
  };
}

describe('describeAutopilot', () => {
  it('prefers the running task, then the last message, then what is next', () => {
    expect(
      describeAutopilot(status({ running: { taskId: 2, title: 'Auth', agentType: 'review' }, message: 'x' }))
    ).toBe('Running task #2 "Auth" (review)');
    expect(describeAutopilot(status({ message: 'Stopped: task #2 blocked' }))).toBe('Stopped: task #2 blocked');
    expect(describeAutopilot(status())).toBe('Next: task #4 "1. Scaffold" · 2 ready, 3 waiting');
    expect(describeAutopilot(status({ next: null, waitingCount: 0 }))).toBe('No tasks to run');
  });
});

describe('AutopilotControls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.projects.getAutopilot).mockResolvedValue(mockTypedResponse(status({ enabled: false })));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders nothing for a project that is not a git repository', async () => {
    vi.mocked(api.projects.getAutopilot).mockResolvedValue(
      mockTypedResponse(status({ isGitRepository: false }))
    );
    const { container } = render(<AutopilotControls projectId={1} />);
    await waitFor(() => expect(api.projects.getAutopilot).toHaveBeenCalledWith(1));
    expect(container).toBeEmptyDOMElement();
  });

  it('asks for confirmation before turning autopilot on', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<AutopilotControls projectId={1} />);
    const checkbox = await screen.findByRole('checkbox');

    fireEvent.click(checkbox);
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/merges each task/));
    expect(api.projects.setAutopilot).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    vi.mocked(api.projects.setAutopilot).mockResolvedValue(mockTypedResponse(status()));
    fireEvent.click(checkbox);

    await waitFor(() => expect(api.projects.setAutopilot).toHaveBeenCalledWith(1, true));
    expect(await screen.findByRole('button', { name: /start/i })).toBeEnabled();
    expect(screen.getByTestId('autopilot-status')).toHaveTextContent('Next: task #4');
  });

  it('turns off without confirmation', async () => {
    vi.mocked(api.projects.getAutopilot).mockResolvedValue(mockTypedResponse(status()));
    vi.mocked(api.projects.setAutopilot).mockResolvedValue(mockTypedResponse(status({ enabled: false })));
    const confirm = vi.spyOn(window, 'confirm');
    render(<AutopilotControls projectId={1} />);

    fireEvent.click(await screen.findByRole('checkbox'));

    await waitFor(() => expect(api.projects.setAutopilot).toHaveBeenCalledWith(1, false));
    expect(confirm).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('button', { name: /start/i })).toBeNull());
  });

  it('disables Start while a task runs or nothing is ready', async () => {
    vi.mocked(api.projects.getAutopilot).mockResolvedValue(
      mockTypedResponse(status({ running: { taskId: 2, title: null, agentType: 'implementation' } }))
    );
    render(<AutopilotControls projectId={1} />);
    expect(await screen.findByRole('button', { name: /start/i })).toBeDisabled();
    expect(screen.getByTestId('autopilot-status')).toHaveTextContent('Running task #2 (implementation)');
  });

  it('starts, reports activity, and shows a 409 reason', async () => {
    vi.mocked(api.projects.getAutopilot).mockResolvedValue(mockTypedResponse(status()));
    vi.mocked(api.projects.startAutopilot).mockResolvedValue(
      mockTypedResponse({ error: 'Done: no tasks left to run.' } as never, { status: 409 })
    );
    const onActivity = vi.fn();
    render(<AutopilotControls projectId={1} onActivity={onActivity} />);

    fireEvent.click(await screen.findByRole('button', { name: /start/i }));

    await waitFor(() => expect(api.projects.startAutopilot).toHaveBeenCalledWith(1));
    expect(onActivity).toHaveBeenCalled();
    expect(await screen.findByText('Done: no tasks left to run.')).toBeInTheDocument();
  });

  it('opens the provider prompt when credentials are missing', async () => {
    vi.mocked(api.projects.getAutopilot).mockResolvedValue(mockTypedResponse(status()));
    vi.mocked(api.projects.startAutopilot).mockResolvedValue(
      mockTypedResponse({ error: 'Connect Claude', code: 'PROVIDER_CREDENTIALS_MISSING' } as never, { status: 403 })
    );
    const onCredentialsMissing = vi.fn();
    render(<AutopilotControls projectId={1} onCredentialsMissing={onCredentialsMissing} />);

    fireEvent.click(await screen.findByRole('button', { name: /start/i }));

    await waitFor(() => expect(onCredentialsMissing).toHaveBeenCalled());
  });

  it('polls while enabled and reports when the running task changes', async () => {
    vi.useFakeTimers();
    vi.mocked(api.projects.getAutopilot).mockResolvedValue(mockTypedResponse(status()));
    const onActivity = vi.fn();
    render(<AutopilotControls projectId={1} onActivity={onActivity} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.projects.getAutopilot).toHaveBeenCalledTimes(1);

    vi.mocked(api.projects.getAutopilot).mockResolvedValue(
      mockTypedResponse(status({ running: { taskId: 4, title: null, agentType: 'planification' } }))
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOPILOT_POLL_MS);
    });

    expect(api.projects.getAutopilot).toHaveBeenCalledTimes(2);
    expect(onActivity).toHaveBeenCalledTimes(1);
  });
});
