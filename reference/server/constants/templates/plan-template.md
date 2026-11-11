# Task {{ task title — replace with the real task title }}

## Original Request

<!--
Quote the user's original request verbatim, as a Markdown blockquote. The source is the
EXISTING content of the task doc at {{taskDocPath}} as you read it BEFORE rewriting it
(plus the task title, if the doc is empty or only contains the title). Do not paraphrase,
summarize, or omit any part of it. This section is mandatory.
-->

> {{ original task doc content, quoted line-by-line }}

## Overview

{{ Problem statement, scope, and any key architectural decisions you made.
   For non-technical users, surface the technical decisions you made silently here so
   future-you and reviewers can audit them. }}

## Relevant Notes

<!--
The project's topic notes for the areas this task touches. Pick them from the "Topic notes"
index in CLAUDE.md (lines like "Before ..., read `docs/agent-notes/<topic>.md`"). The
implementation and review agents read every note listed here before they start; notes are
not loaded otherwise. Write "None" if the project has no such index or no note applies.
-->

- `docs/agent-notes/{{ topic }}.md` — {{ why it applies }}

## Implementation Plan

### Phase 1: {{ phase title }}

**Files to modify / create:**
- `path/to/file.ext` — {{ what changes }}

{{ Step-by-step changes, with code snippets, before/after, or rationale where useful. }}

### Phase 2: {{ phase title }}

{{ … repeat as needed. Order phases logically: infrastructure → models → controllers →
   views → helpers/utilities. Each phase should be a logical chunk a reviewer can verify
   in isolation. }}

## Testing Strategy

### Unit tests
- {{ spec/test files and what each one covers }}

### Manual / Playwright MCP testing
- {{ scenarios with steps and expected results, or an explicit "not needed because …" }}

## To-Do List

<!--
One "### Phase N: <title>" section per Implementation Plan phase, numbered and titled the
same. Each phase holds its own code AND test items, so a finished phase is a tested one.
Implementation runs one phase per fresh session (the context stays small, which keeps each
run cheap): make every phase a coherent chunk that can be finished and committed on its own.
Use a single phase only for a small change (at most ~6 items, one or two layers); split
anything bigger. Put manual / Playwright checks in the last phase.
-->

### Phase 1: {{ phase title }}
- [ ] {{ implementation step }}
- [ ] {{ tests for this phase }}

### Phase 2: {{ phase title }}
- [ ] {{ implementation step }}
- [ ] {{ tests for this phase }}

## Progress Log

<!--
Leave empty. Each implementation run appends an entry here when it finishes a phase:
its commit, what it did, and what the next phase needs to know.
-->

## Project Docs Update

{{ Note any updates required to .bottega/project.md (architecture, new patterns, new
   files), or write "Not needed for this change." }}
