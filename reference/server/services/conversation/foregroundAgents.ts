/**
 * Keeps sub-agents in the foreground. Since claude-agent-sdk 0.3.301 the Agent
 * tool backgrounds sub-agents by default, and that breaks Bottega twice over:
 * a background sub-agent can't use the parent's bypassPermissions (every Bash
 * call is auto-denied), and Bottega ends the query at the turn's `result`, so
 * an agent that waits for a background sub-agent is aborted before it reports
 * back (task #56's planner, 2026-10-19). SendMessage is refused because a
 * resumed sub-agent always runs in the background.
 */

// `Task` is the Agent tool's older name.
export const FOREGROUND_AGENTS_MATCHER = 'Agent|Task|SendMessage';

export const SEND_MESSAGE_DENY_MESSAGE =
  'SendMessage is not available here: a resumed agent runs in the background, and this session ' +
  'ends before background work reports back. Launch a new Agent instead, with everything it needs in its prompt.';

interface PreToolUseInput {
  hook_event_name: string;
  tool_name?: string;
  tool_input?: unknown;
}

/** Claude Agent SDK PreToolUse hook (matcher `FOREGROUND_AGENTS_MATCHER`). */
export function foregroundAgentsHook(input: PreToolUseInput): Promise<Record<string, unknown>> {
  if (input.hook_event_name !== 'PreToolUse') return Promise.resolve({});

  if (input.tool_name === 'SendMessage') {
    return Promise.resolve({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: SEND_MESSAGE_DENY_MESSAGE,
      },
    });
  }

  if (input.tool_name === 'Agent' || input.tool_name === 'Task') {
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    return Promise.resolve({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { ...toolInput, run_in_background: false },
      },
    });
  }

  return Promise.resolve({});
}
