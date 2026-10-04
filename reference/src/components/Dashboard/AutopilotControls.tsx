/**
 * AutopilotControls.tsx - the board's Autopilot switch (extra/autopilot.md)
 *
 * A checkbox that turns autopilot on for the project, a Start button that
 * starts the next ready task, and a one-line status. While enabled, the
 * status is re-read every few seconds; `onActivity` fires whenever the
 * running task or message changes so the board can reload its tasks.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Play, Rocket } from 'lucide-react';
import { Button } from '../ui/button';
import { api } from '../../utils/api';
import type { AutopilotStatusResponse } from '../../../shared/api/projects';

export const AUTOPILOT_POLL_MS = 5000;

export interface AutopilotControlsProps {
  projectId: number;
  /** Called when autopilot moved on (new running task / message). */
  onActivity?: () => void;
  /** Called when the start failed because the provider isn't connected. */
  onCredentialsMissing?: () => void;
}

const ENABLE_CONFIRM =
  'Autopilot runs every ready task through planning, implementation, review and the PR ' +
  'without asking you anything (agents pick the recommended answer), and merges each task ' +
  'into the default branch when its tests pass. Turn it on?';

export function describeAutopilot(status: AutopilotStatusResponse): string {
  if (status.running) {
    const title = status.running.title ? ` "${status.running.title}"` : '';
    return `Running task #${status.running.taskId}${title} (${status.running.agentType})`;
  }
  if (status.message) return status.message;
  if (status.next) {
    const title = status.next.title ? ` "${status.next.title}"` : '';
    return `Next: task #${status.next.taskId}${title} · ${status.readyCount} ready, ${status.waitingCount} waiting`;
  }
  return status.waitingCount > 0
    ? `${status.waitingCount} task(s) waiting on dependencies`
    : 'No tasks to run';
}

function startTooltip(status: AutopilotStatusResponse): string {
  if (status.running) return `Task #${status.running.taskId} is running`;
  if (!status.next) return 'No task is ready (all done, or waiting on dependencies)';
  return `Start task #${status.next.taskId}, then keep going`;
}

function AutopilotControls({ projectId, onActivity, onCredentialsMissing }: AutopilotControlsProps) {
  const [status, setStatus] = useState<AutopilotStatusResponse | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activityKey = useRef<string | null>(null);

  const applyStatus = useCallback(
    (next: AutopilotStatusResponse) => {
      setStatus(next);
      const key = `${next.running?.taskId ?? ''}|${next.running?.agentType ?? ''}|${next.message ?? ''}`;
      if (activityKey.current !== null && activityKey.current !== key) {
        onActivity?.();
      }
      activityKey.current = key;
    },
    [onActivity]
  );

  const loadStatus = useCallback(async () => {
    try {
      const response = await api.projects.getAutopilot(projectId);
      if (response.ok) applyStatus(await response.json());
    } catch (err) {
      console.error('Error loading autopilot status:', err);
    }
  }, [projectId, applyStatus]);

  useEffect(() => {
    activityKey.current = null;
    void loadStatus();
  }, [loadStatus]);

  const enabled = !!status?.enabled;
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => void loadStatus(), AUTOPILOT_POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, loadStatus]);

  const handleToggle = async (next: boolean) => {
    if (next && !window.confirm(ENABLE_CONFIRM)) return;
    setIsBusy(true);
    setError(null);
    try {
      const response = await api.projects.setAutopilot(projectId, next);
      if (response.ok) {
        applyStatus(await response.json());
      } else {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        setError(data.error || 'Failed to update autopilot');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBusy(false);
    }
  };

  const handleStart = async () => {
    setIsBusy(true);
    setError(null);
    try {
      const response = await api.projects.startAutopilot(projectId);
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
        if (response.status === 403 && data.code === 'PROVIDER_CREDENTIALS_MISSING') {
          onCredentialsMissing?.();
        }
        setError(data.error || 'Failed to start autopilot');
      }
      onActivity?.();
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBusy(false);
    }
  };

  if (!status?.isGitRepository) return null;

  const line = error ?? describeAutopilot(status);

  return (
    <div className="flex flex-wrap items-center gap-2 min-w-0" role="group" aria-label="Autopilot">
      <label
        className="flex items-center gap-1.5 text-xs font-medium cursor-pointer"
        title="Run tasks in dependency order without questions; merge each when its tests pass"
      >
        <input
          type="checkbox"
          checked={enabled}
          disabled={isBusy}
          onChange={(e) => void handleToggle(e.target.checked)}
          className="h-3.5 w-3.5 rounded border-border text-primary focus:ring-primary"
        />
        <Rocket className="w-3.5 h-3.5 text-muted-foreground" />
        Autopilot
      </label>
      {enabled && (
        <span title={startTooltip(status)}>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleStart()}
            className="h-7 text-xs"
            disabled={isBusy || !!status.running || !status.next}
          >
            {isBusy ? (
              <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
            ) : (
              <Play className="w-3.5 h-3.5 mr-1" />
            )}
            Start
          </Button>
        </span>
      )}
      {enabled && (
        <span
          className={`text-xs truncate max-w-[28rem] ${error ? 'text-destructive' : 'text-muted-foreground'}`}
          title={line}
          data-testid="autopilot-status"
        >
          {line}
        </span>
      )}
    </div>
  );
}

export default AutopilotControls;
