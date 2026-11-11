// Plan phases in the task doc's To-Do List (core/execution-loop.md, "One
// implementation run per plan phase"). The planner groups the To-Do List into
// `### Phase N: <title>` sections; implementation runs one phase at a time.
// Items under a To-Do heading that isn't a phase count toward the last phase.
// A doc with fewer than two phase sections isn't phased: one run does it all.

export interface TaskPhase {
  /** The phase's number: the N of "Phase N", else its position (1-based). */
  number: number;
  title: string;
  total: number;
  done: number;
}

const TODO_HEADING = /^##\s+To-?Do\b/i;
const H2 = /^##\s/;
const H3 = /^###\s+(.*?)\s*$/;
const PHASE_HEADING = /^Phase\s+(\d+)\b\s*[:.\-–—]?\s*(.*)$/i;
const CHECKBOX = /^\s*[-*+]\s+\[([ xX])\]/;

/** The To-Do List's phases, in order; [] when it has no phase sections. */
export function parseTodoPhases(markdown: string): TaskPhase[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => TODO_HEADING.test(l));
  if (start === -1) return [];

  const phases: TaskPhase[] = [];
  let current: TaskPhase | null = null;
  // Items before the first phase heading, or under a non-phase heading that
  // comes before any phase, are held and given to the last phase at the end.
  let orphanTotal = 0;
  let orphanDone = 0;
  let inFence = false;

  for (const line of lines.slice(start + 1)) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence) continue;
    if (H2.test(line)) break;

    const h3 = H3.exec(line);
    if (h3) {
      const phase = PHASE_HEADING.exec(h3[1]!);
      if (phase) {
        current = {
          number: Number(phase[1]),
          title: phase[2]!.trim() || `Phase ${phase[1]}`,
          total: 0,
          done: 0,
        };
        phases.push(current);
      }
      // A non-phase heading keeps adding to the phase before it (or to the
      // orphans, before any phase).
      continue;
    }

    const box = CHECKBOX.exec(line);
    if (!box) continue;
    const checked = box[1] !== ' ';
    if (current) {
      current.total += 1;
      if (checked) current.done += 1;
    } else {
      orphanTotal += 1;
      if (checked) orphanDone += 1;
    }
  }

  if (phases.length === 0) return [];
  const last = phases[phases.length - 1]!;
  last.total += orphanTotal;
  last.done += orphanDone;
  return phases;
}

/** The phases, when the doc is phased (two or more phase sections); else []. */
export function phasedTodo(markdown: string): TaskPhase[] {
  const phases = parseTodoPhases(markdown);
  return phases.length >= 2 ? phases : [];
}

/** The first phase with an unchecked item, or null when all are done. */
export function nextUnfinishedPhase(phases: TaskPhase[]): TaskPhase | null {
  return phases.find((p) => p.done < p.total) ?? null;
}

/**
 * Whether an implementation run scoped to phase `runPhase` should chain to a
 * fresh run for a later phase: its own phase is now finished and a later one
 * still has unchecked items.
 */
export function phaseToContinue(markdown: string, runPhase: number): TaskPhase | null {
  const phases = phasedTodo(markdown);
  const own = phases.find((p) => p.number === runPhase);
  if (!own || own.done < own.total) return null;
  const next = nextUnfinishedPhase(phases);
  return next && next.number !== runPhase ? next : null;
}
