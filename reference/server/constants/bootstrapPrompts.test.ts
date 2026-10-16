import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  extractVariables,
  getPromptDefinition,
  loadDefault,
  renderPrompt,
} from '../services/promptRenderer.js';

// Default project-bootstrap templates (extra/project-bootstrap.md). These are
// the first user message of a long manual chat, so the non-negotiables must
// live in the template itself.

const BOOTSTRAP_PROMPTS = ['prd', 'ard', 'task-breakdown'] as const;

const VARS = { mode: 'refine', input: 'MVP only, web first', taskId: 1234 };

describe('project bootstrap prompts', () => {
  let archiveRoot: string;

  beforeEach(() => {
    // Keep user overrides out of the picture.
    archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-prompts-test-'));
    process.env.BOTTEGA_ARCHIVE_ROOT = archiveRoot;
  });

  afterEach(() => {
    fs.rmSync(archiveRoot, { recursive: true, force: true });
    delete process.env.BOTTEGA_ARCHIVE_ROOT;
  });

  describe.each(BOOTSTRAP_PROMPTS)('%s', (name) => {
    it('is registered with the bootstrap variable allowlist', () => {
      const def = getPromptDefinition(name);
      expect(def).not.toBeNull();
      expect(def!.kind).toBe('prompt');
      expect([...def!.variables].sort()).toEqual(['input', 'mode', 'scriptsDir', 'taskId']);
    });

    it('uses only declared variables and renders them all', () => {
      const def = getPromptDefinition(name)!;
      const used = extractVariables(loadDefault(name));
      expect(used.filter((v) => !def.variables.includes(v))).toEqual([]);
      expect(used).toEqual(expect.arrayContaining(['mode', 'input', 'taskId']));

      const rendered = renderPrompt(name, VARS);
      expect(rendered).not.toMatch(/\{\{\w+\}\}/);
      expect(rendered).toContain('MVP only, web first');
      expect(rendered).toContain('1234');
    });

    it('forbids pushing and opening a PR', () => {
      expect(loadDefault(name)).toMatch(/never (commit, )?push,? or open a pull request/i);
    });

    it('requires explicit confirmation before acting', () => {
      expect(loadDefault(name)).toMatch(/without that confirmation/);
    });

    it('falls back to plain-text questions without a structured-question tool', () => {
      const content = loadDefault(name);
      expect(content).toContain('AskUserQuestion');
      expect(content).toMatch(/plain text[\s\S]*end your turn/i);
    });
  });

  describe.each(['prd', 'ard'] as const)('%s document session', (name) => {
    it('links both documents from CLAUDE.md with plain links, not imports', () => {
      const content = loadDefault(name);
      expect(content).toContain('## Project documents');
      expect(content).toContain('[PRD.md](PRD.md)');
      expect(content).toContain('[ARD.md](ARD.md)');
      expect(content).toMatch(/never `@(PRD|ARD)\.md` imports/);
    });

    it('interviews with a recommended option, an understanding line, and the 99% bar', () => {
      const content = loadDefault(name);
      expect(content).toMatch(/at most 4 questions per call/);
      expect(content).toMatch(/recommended option listed first/);
      expect(content).toContain('Understanding:');
      expect(content).toContain('≥ 99%');
      expect(content).toContain('Open questions');
    });

    it('commits only its own document and CLAUDE.md, after writing and after each edit', () => {
      const content = loadDefault(name);
      const doc = name === 'prd' ? 'PRD.md' : 'ARD.md';
      expect(content).toContain(`git add ${doc} CLAUDE.md`);
      expect(content).toMatch(/commit each round of changes/);
      expect(content).toMatch(/never `git add -A` or `git add \.`/);
    });

    it('handles create and refine modes', () => {
      const content = loadDefault(name);
      expect(content).toMatch(/`create` means/);
      expect(content).toMatch(/`refine` means/);
    });
  });

  it('the PRD session confirms each persona experience one by one before writing', () => {
    const content = loadDefault('prd');
    const walkthrough = content.indexOf('Persona walkthrough');
    const writeConfirm = content.indexOf('`Write PRD now`');
    expect(walkthrough).toBeGreaterThan(content.indexOf('≥ 99%'));
    expect(writeConfirm).toBeGreaterThan(walkthrough);
    expect(content).toMatch(/one persona at a time/);
    expect(content).toContain('`Looks right` / `Needs changes`');
    expect(content).toMatch(/after \*\*every\*\* persona is confirmed/);
  });

  it('the ARD session asks about constraints first, then proposes for accept or correct', () => {
    const content = loadDefault('ard');
    const phase1 = content.indexOf('Phase 1: Requirements and constraints');
    const phase2 = content.indexOf('Phase 2: Propose');
    expect(phase1).toBeGreaterThan(0);
    expect(phase2).toBeGreaterThan(phase1);
    for (const topic of ['Cost limits', 'Scale', 'Reliability', 'Security and compliance', 'Team']) {
      expect(content).toContain(`**${topic}**`);
    }
    expect(content).toMatch(/Never ask them to choose a technology in this phase/);
    expect(content).toMatch(/Never ask an open technical question/);
    expect(content).toContain('`Accept` (first, recommended) or `Change`');
    expect(content).toMatch(/deployment strategy/);
  });

  it('the ARD session covers the testing strategy and rejected alternatives', () => {
    const content = loadDefault('ard');
    expect(content).toMatch(/Testing strategy/i);
    expect(content).toMatch(/rejected alternatives/);
  });

  it('the ARD session proposes the simplest architecture and justifies every component', () => {
    const content = loadDefault('ard');
    expect(content).toMatch(/simplest architecture that meets the requirements/);
    expect(content).toMatch(/Justify every component with a specific requirement/);
    expect(content).toMatch(/Do not add these by default/);
    expect(content).toContain('**simplicity check**');
  });

  it("the ARD session researches third-party services for the users' location and records their docs", () => {
    const content = loadDefault('ard');
    expect(content).toContain('**Location**');
    expect(content).toMatch(/Research every third-party service/);
    expect(content).toMatch(/WebSearch/);
    expect(content).toMatch(/official, latest API documentation/);
    expect(content).toContain('**External services and integrations**');
  });

  it('the task breakdown never commits', () => {
    expect(loadDefault('task-breakdown')).toMatch(/never commit, push, or open a pull request/i);
  });

  it('the task breakdown splits vertically into milestones that end in milestone tasks', () => {
    const content = loadDefault('task-breakdown');
    expect(content).toMatch(/Split vertically, never horizontally/);
    expect(content).toMatch(/thinnest end-to-end path a person can try/);
    expect(content).toContain('"kind": "milestone"');
    expect(content).toContain('## Verification scenarios');
    expect(content).toMatch(/depends on the previous milestone/);
  });

  it('the task breakdown runs create-tasks.ts with the session task id', () => {
    const rendered = renderPrompt('task-breakdown', VARS);
    expect(rendered).toMatch(/tsx \S+\/create-tasks\.ts 1234 bootstrap-tasks\.json/);
    expect(rendered).not.toContain('{{scriptsDir}}');
  });
});

describe('milestone verification prompt', () => {
  const VARS = { taskId: 77, taskDocPath: '/docs/task-77.md' };

  it('is registered and renders exactly its declared variables', () => {
    const def = getPromptDefinition('milestone-verification');
    expect(def).not.toBeNull();
    expect([...def!.variables].sort()).toEqual(['taskDocPath', 'taskId']);
    expect(extractVariables(loadDefault('milestone-verification')).sort()).toEqual(['taskDocPath', 'taskId']);
    const rendered = renderPrompt('milestone-verification', VARS);
    expect(rendered).not.toMatch(/\{\{\w+\}\}/);
    expect(rendered).toContain('/docs/task-77.md');
  });

  it('makes the app run before handing over, then writes the guide into the task doc', () => {
    const content = loadDefault('milestone-verification');
    expect(content.indexOf('Make it run')).toBeLessThan(content.indexOf('Write the verification guide'));
    expect(content).toMatch(/full\*\* test suite/);
    expect(content).toContain('## Verification guide');
    for (const section of ['Prerequisites', 'External accounts', 'Configuration', 'Setup', 'Run', 'Verify']) {
      expect(content).toContain(`**${section}**`);
    }
  });

  it('closes only on the human\'s confirmation, via Merge without PR', () => {
    const content = loadDefault('milestone-verification');
    expect(content).toMatch(/Only when the human confirms/);
    expect(content).toContain('Merge without PR');
  });

  it('never pushes, opens a PR, or reads secrets', () => {
    const content = loadDefault('milestone-verification');
    expect(content).toMatch(/Never push or open a pull request/);
    expect(content).toMatch(/never open or print `\.env`/);
  });
});
