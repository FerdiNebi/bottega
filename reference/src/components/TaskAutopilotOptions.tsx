/**
 * The two per-task autopilot switches (extra/autopilot.md, "Per-task switches"):
 * may autopilot start this task from Pending, and may it work on it at all.
 * Used by the New Task form and Task Detail.
 */

import { Bot } from 'lucide-react';
import { cn } from '../lib/utils';

export interface TaskAutopilotFlags {
  autopilot_can_start: boolean;
  autopilot_can_work: boolean;
}

export interface TaskAutopilotOptionsProps {
  value: TaskAutopilotFlags;
  onChange: (next: TaskAutopilotFlags) => void;
  disabled?: boolean | undefined;
  /** Keeps checkbox ids unique when several instances are on screen. */
  idPrefix?: string | undefined;
  /** One row, explanations in tooltips — for Task Detail, where space is tight. */
  compact?: boolean | undefined;
  className?: string | undefined;
}

const WORK_HELP = 'Off: every step is manual — questions are asked, the plan waits for you, nothing is merged for you.';
const START_HELP = 'Off: the task stays in Pending until you press Run.';

function TaskAutopilotOptions({
  value,
  onChange,
  disabled = false,
  idPrefix = 'task-autopilot',
  compact = false,
  className,
}: TaskAutopilotOptionsProps) {
  const workId = `${idPrefix}-can-work`;
  const startId = `${idPrefix}-can-start`;
  const checkboxClass = 'h-4 w-4 rounded border-border text-primary focus:ring-primary';

  if (compact) {
    return (
      <div className={cn('flex flex-wrap items-center gap-x-3 sm:gap-x-4 gap-y-1 text-xs sm:text-sm', className)}>
        <span className="flex items-center gap-1.5 font-medium text-foreground">
          <Bot className="w-4 h-4 text-muted-foreground" />
          Autopilot
        </span>
        {/* The two switches stay on one line together, even on a phone. */}
        <span className="flex items-center gap-x-3 sm:gap-x-4 whitespace-nowrap">
        <label htmlFor={workId} title={WORK_HELP} className="flex items-center gap-1.5 text-foreground cursor-pointer">
          <input
            type="checkbox"
            id={workId}
            checked={value.autopilot_can_work}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, autopilot_can_work: e.target.checked })}
            className={checkboxClass}
          />
          may work on it
        </label>
        <label
          htmlFor={startId}
          title={START_HELP}
          className={cn('flex items-center gap-1.5 text-foreground cursor-pointer', !value.autopilot_can_work && 'opacity-50')}
        >
          <input
            type="checkbox"
            id={startId}
            checked={value.autopilot_can_start}
            disabled={disabled || !value.autopilot_can_work}
            onChange={(e) => onChange({ ...value, autopilot_can_start: e.target.checked })}
            className={checkboxClass}
          />
          may start it
        </label>
        </span>
      </div>
    );
  }

  return (
    <div className={cn('p-3 bg-muted/50 rounded-md border border-border space-y-2', className)}>
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Bot className="w-4 h-4 text-muted-foreground" />
        Autopilot
      </div>
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          id={workId}
          checked={value.autopilot_can_work}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, autopilot_can_work: e.target.checked })}
          className="mt-0.5 h-4 w-4 rounded border-border text-primary focus:ring-primary"
        />
        <div className="flex-1 min-w-0">
          <label htmlFor={workId} className="text-sm text-foreground cursor-pointer">
            Autopilot may work on this task
          </label>
          <p className="text-xs text-muted-foreground mt-0.5">{WORK_HELP}</p>
        </div>
      </div>
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          id={startId}
          checked={value.autopilot_can_start}
          disabled={disabled || !value.autopilot_can_work}
          onChange={(e) => onChange({ ...value, autopilot_can_start: e.target.checked })}
          className="mt-0.5 h-4 w-4 rounded border-border text-primary focus:ring-primary"
        />
        <div className="flex-1 min-w-0">
          <label
            htmlFor={startId}
            className={cn('text-sm text-foreground cursor-pointer', !value.autopilot_can_work && 'opacity-50')}
          >
            Autopilot may start this task
          </label>
          <p className="text-xs text-muted-foreground mt-0.5">{START_HELP}</p>
        </div>
      </div>
    </div>
  );
}

export default TaskAutopilotOptions;
