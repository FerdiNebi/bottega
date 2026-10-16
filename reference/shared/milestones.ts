// Milestone tasks (extra/project-bootstrap.md, "Milestones and manual
// verification"): manual verification checkpoints created by the task
// breakdown and titled "<level>. Milestone: <title>". The title is the whole
// marker — no column — like the level prefix it sits behind.

export const MILESTONE_PREFIX = 'Milestone: ';

const MILESTONE_TITLE = /^(?:\d+\.\s+)?Milestone:\s/i;

export function isMilestoneTitle(title: string | null | undefined): boolean {
  return MILESTONE_TITLE.test(title ?? '');
}
