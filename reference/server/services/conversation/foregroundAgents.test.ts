import { describe, it, expect } from 'vitest';
import { SEND_MESSAGE_DENY_MESSAGE, foregroundAgentsHook } from './foregroundAgents.js';

describe('foregroundAgentsHook', () => {
  it('runs sub-agents in the foreground, keeping the rest of the input', async () => {
    for (const toolName of ['Agent', 'Task']) {
      const result = await foregroundAgentsHook({
        hook_event_name: 'PreToolUse',
        tool_name: toolName,
        tool_input: { description: 'Explore', prompt: 'Look around', subagent_type: 'Plan', run_in_background: true },
      });
      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { description: 'Explore', prompt: 'Look around', subagent_type: 'Plan', run_in_background: false },
        },
      });
    }
  });

  it('forces the foreground when the agent left the background default', async () => {
    const result = await foregroundAgentsHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      tool_input: { description: 'Explore', prompt: 'Look around' },
    });
    expect(result).toMatchObject({ hookSpecificOutput: { updatedInput: { run_in_background: false } } });
  });

  it('refuses SendMessage, which would resume an agent in the background', async () => {
    const result = await foregroundAgentsHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'SendMessage',
      tool_input: { to: 'a718c02a9b111f086', message: 'Continue' },
    });
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: SEND_MESSAGE_DENY_MESSAGE,
      },
    });
  });

  it('lets other tools through', async () => {
    expect(await foregroundAgentsHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} })).toEqual({});
  });
});
