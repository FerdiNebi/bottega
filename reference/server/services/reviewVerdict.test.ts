import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let docPath = '';
vi.mock('./documentation.js', () => ({
  getTaskDocPath: () => docPath,
}));

import { recordReviewStart, reviewLeftNoVerdict } from './reviewVerdict.js';

let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-verdict-'));
  docPath = path.join(dir, 'task-7.md');
  fs.writeFileSync(docPath, '# Task\n\n## Review Findings\n\n**Status:** NEEDS_WORK\n');
  fs.utimesSync(docPath, new Date('2026-11-18T08:00:00Z'), new Date('2026-11-18T08:00:00Z'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('reviewLeftNoVerdict', () => {
  it('is true when the task doc was not touched during the review', () => {
    recordReviewStart(1, 4, 7);
    expect(reviewLeftNoVerdict(1, 4, 7)).toBe(true);
  });

  it('is false when the review wrote the task doc', () => {
    recordReviewStart(2, 4, 7);
    fs.writeFileSync(docPath, '# Task\n\n## Review Findings\n\n**Status:** READY\n');
    expect(reviewLeftNoVerdict(2, 4, 7)).toBe(false);
  });

  it('counts rewriting identical content as a verdict (same IN_PROGRESS list twice)', () => {
    const content = fs.readFileSync(docPath, 'utf8');
    recordReviewStart(3, 4, 7);
    fs.writeFileSync(docPath, content);
    expect(reviewLeftNoVerdict(3, 4, 7)).toBe(false);
  });

  it('is false for a run whose start was never recorded', () => {
    expect(reviewLeftNoVerdict(99, 4, 7)).toBe(false);
  });

  it('consumes the record', () => {
    recordReviewStart(4, 4, 7);
    expect(reviewLeftNoVerdict(4, 4, 7)).toBe(true);
    expect(reviewLeftNoVerdict(4, 4, 7)).toBe(false);
  });

  it('treats a doc that appeared during the review as a verdict', () => {
    fs.rmSync(docPath);
    recordReviewStart(5, 4, 7);
    fs.writeFileSync(docPath, '## Review Findings\n');
    expect(reviewLeftNoVerdict(5, 4, 7)).toBe(false);
  });
});
