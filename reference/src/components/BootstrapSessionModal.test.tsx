import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import BootstrapSessionModal, { getBootstrapFieldConfig } from './BootstrapSessionModal';

vi.mock('./MicButton', () => ({
  MicButton: () => <button data-testid="mic-button" type="button">Mic</button>,
}));

vi.mock('lucide-react', () => ({
  X: () => <span data-testid="icon-x" />,
  FileText: () => <span data-testid="icon-file" />,
}));

describe('getBootstrapFieldConfig', () => {
  it('requires an idea only when creating a PRD', () => {
    expect(getBootstrapFieldConfig('prd', 'create')).toMatchObject({
      label: 'Describe your idea',
      required: true,
    });
    expect(getBootstrapFieldConfig('prd', 'refine')).toMatchObject({
      label: 'What should change?',
      required: false,
    });
    expect(getBootstrapFieldConfig('ard', 'create')).toMatchObject({
      label: 'Constraints or preferences',
      required: false,
    });
    expect(getBootstrapFieldConfig('ard', 'refine')).toMatchObject({
      title: 'Refine ARD',
      label: 'What should change?',
      required: false,
    });
    expect(getBootstrapFieldConfig('tasks', 'create')).toMatchObject({
      title: 'Create initial tasks',
      label: 'Guidance, e.g. "MVP only"',
      required: false,
    });
  });
});

describe('BootstrapSessionModal', () => {
  const defaultProps = {
    isOpen: true,
    kind: 'prd' as const,
    mode: 'create' as const,
    onClose: vi.fn(),
    onSubmit: vi.fn(),
    projectName: 'Test Project',
    isSubmitting: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when closed', () => {
    const { container } = render(<BootstrapSessionModal {...defaultProps} isOpen={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('requires the idea for Create PRD', () => {
    render(<BootstrapSessionModal {...defaultProps} />);
    expect(screen.getByText('Create PRD')).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Start interview' });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Describe your idea'), { target: { value: 'Lunch app' } });
    expect(submit).not.toBeDisabled();
  });

  it('allows an empty input in refine mode and submits the chosen provider and model', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ success: true });
    render(<BootstrapSessionModal {...defaultProps} mode="refine" onSubmit={onSubmit} />);

    expect(screen.getByText('Refine PRD')).toBeInTheDocument();
    expect(screen.getByLabelText(/What should change\?/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({ input: '', provider: 'anthropic', model: 'sonnet' });
    });
  });

  it('trims the input for the ARD and task sessions', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ success: true });
    render(<BootstrapSessionModal {...defaultProps} kind="tasks" onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText(/Guidance/), { target: { value: '  MVP only  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start breakdown' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ input: 'MVP only' }));
    });
  });

  it('shows a 409 prerequisite error returned by onSubmit', async () => {
    const onSubmit = vi.fn().mockResolvedValue({
      success: false,
      error: 'ARD.md must be merged into main before creating initial tasks',
    });
    render(<BootstrapSessionModal {...defaultProps} kind="tasks" onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole('button', { name: 'Start breakdown' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('ARD.md must be merged into main');
  });

  it('shows a missing-credentials error returned by onSubmit', async () => {
    const onSubmit = vi.fn().mockResolvedValue({
      success: false,
      error: 'OpenAI credentials are not provisioned for this user.',
    });
    render(<BootstrapSessionModal {...defaultProps} kind="ard" onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole('button', { name: 'Start interview' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('credentials are not provisioned');
  });

  it('closes on Cancel', () => {
    render(<BootstrapSessionModal {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(defaultProps.onClose).toHaveBeenCalled();
  });
});
