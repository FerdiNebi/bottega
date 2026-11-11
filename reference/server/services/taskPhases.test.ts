import { describe, it, expect } from 'vitest';
import { nextUnfinishedPhase, parseTodoPhases, phasedTodo, phaseToContinue } from './taskPhases.js';

const doc = (todo: string) => `# Task 1: Thing

## Implementation Plan

### Phase 1: Not a to-do heading
- [ ] this checkbox is in the plan, not the To-Do List

## To-Do List

${todo}

## Progress Log

## Project Docs Update

- [ ] not a to-do item either
`;

const phased = doc(`### Phase 1: Schema and migration
- [x] add the column
- [x] migration test

### Phase 2: Owner UI
- [x] form field
- [ ] form tests

### Phase 3: Docs
- [ ] help guide`);

describe('parseTodoPhases', () => {
  it('reads each phase section of the To-Do List with its checkbox counts', () => {
    expect(parseTodoPhases(phased)).toEqual([
      { number: 1, title: 'Schema and migration', total: 2, done: 2 },
      { number: 2, title: 'Owner UI', total: 2, done: 1 },
      { number: 3, title: 'Docs', total: 1, done: 0 },
    ]);
  });

  it('returns [] for an older doc with Implementation / Testing sections', () => {
    expect(parseTodoPhases(doc('### Implementation\n- [ ] a\n\n### Testing\n- [ ] b'))).toEqual([]);
  });

  it('returns [] without a To-Do List', () => {
    expect(parseTodoPhases('# Task\n\n- [ ] stray')).toEqual([]);
  });

  it('gives items under non-phase headings to the last phase', () => {
    const phases = parseTodoPhases(
      doc('- [x] loose item\n\n### Phase 1: A\n- [x] a\n\n### Phase 2: B\n- [ ] b\n\n### Manual testing\n- [ ] click through'),
    );
    expect(phases.map((p) => [p.number, p.total, p.done])).toEqual([
      [1, 1, 1],
      [2, 3, 1],
    ]);
  });

  it('accepts other phase heading styles, X marks and CRLF line endings', () => {
    const phases = parseTodoPhases(
      doc('### Phase 1 — Data\r\n* [X] a\r\n\r\n### phase 2. UI\r\n+ [ ] b').replace(/\n/g, '\r\n'),
    );
    expect(phases).toEqual([
      { number: 1, title: 'Data', total: 1, done: 1 },
      { number: 2, title: 'UI', total: 1, done: 0 },
    ]);
  });

  it('ignores checkboxes inside code fences', () => {
    const phases = parseTodoPhases(doc('### Phase 1: A\n- [x] a\n```md\n- [ ] example\n```\n\n### Phase 2: B\n- [ ] b'));
    expect(phases[0]).toEqual({ number: 1, title: 'A', total: 1, done: 1 });
  });
});

describe('phasedTodo / nextUnfinishedPhase', () => {
  it('treats a single phase as not phased', () => {
    expect(phasedTodo(doc('### Phase 1: Everything\n- [ ] a'))).toEqual([]);
  });

  it('finds the first phase with an unchecked item', () => {
    expect(nextUnfinishedPhase(phasedTodo(phased))?.number).toBe(2);
  });

  it('returns null when every phase is done', () => {
    expect(nextUnfinishedPhase(phasedTodo(doc('### Phase 1: A\n- [x] a\n\n### Phase 2: B\n- [x] b')))).toBeNull();
  });
});

describe('phaseToContinue', () => {
  it('continues when the run finished its phase and a later phase is open', () => {
    expect(phaseToContinue(phased, 1)?.number).toBe(2);
  });

  it('does not continue when the run left its own phase unfinished', () => {
    expect(phaseToContinue(phased, 2)).toBeNull();
  });

  it('does not continue after the last phase', () => {
    const done = doc('### Phase 1: A\n- [x] a\n\n### Phase 2: B\n- [x] b');
    expect(phaseToContinue(done, 2)).toBeNull();
  });

  it('does not continue for a phase the doc no longer has', () => {
    expect(phaseToContinue(phased, 7)).toBeNull();
  });
});
