/**
 * Agent Prompt Generators (Server-Side)
 *
 * Each generator loads a markdown template (with optional user override at
 * ~/.bottega/prompts/{name}.md), pre-builds any dynamic sections (loops,
 * conditionals) in JS, then injects them via {{var}} substitution. Edit the
 * markdown templates in server/constants/prompts/ — or via the Settings UI —
 * to change agent behavior without touching code.
 */

import {
  renderPrompt,
  resolvePromptPath,
  SCRIPTS_DIR,
  toPromptPath,
} from '../services/promptRenderer.js';

interface FileContext {
  path?: string;
  line?: number | null;
  startLine?: number | null;
  diffHunk?: string | null;
  side?: string | null;
}

interface CommentWebhookContext {
  commentBody?: string;
  commentAuthor?: string;
  fileContext?: FileContext | null;
}

interface ReviewComment {
  commentBody?: string;
  commentAuthor?: string;
  fileContext?: FileContext | null;
}

interface ReviewWebhookContext {
  reviewBody?: string | null;
  reviewAuthor?: string;
  comments?: ReviewComment[];
}

/**
 * Pre-rendered {{prCreateOrVerifyBlock}} — the "create a new PR" vs "verify the
 * existing PR" opening step of the PR/CI procedure inlined into pr.md and yolo.md.
 */
function buildPrCreateOrVerifyBlock(
  taskId: number,
  prUrl: string | null | undefined,
  baseBranch: string,
): string {
  // Rebasing before the first push (and before reusing an existing PR) keeps
  // the PR from starting out conflicting: GitHub runs no CI on a conflicting
  // PR, so the CI wait below would never end.
  const rebaseStep = `Rebase onto the latest \`${baseBranch}\` so the PR doesn't start out conflicting:
   \`\`\`bash
   git fetch origin ${baseBranch} && git rebase origin/${baseBranch}
   \`\`\`
   - On conflicts: resolve each file keeping the intent of both sides, \`git add\` it, then \`git rebase --continue\`. Never \`git rebase --skip\` a commit that contains task work.
   - If you resolved any conflicts, run the project's tests (and build) before pushing, and commit fixes for anything the combined code broke.`;

  if (prUrl) {
    return `### 1. Update the Existing PR
A PR already exists at ${prUrl}. Bring it up to date before checking CI:
1. If \`git status\` shows uncommitted changes, commit them: \`git add -A && git commit -m "<what changed>"\`
2. ${rebaseStep}
3. Push (a no-op when nothing changed): \`git push --force-with-lease\``;
  }
  return `### 1. Create PR
Create a PR for this task:
1. Check for uncommitted changes: \`git status\`
2. If changes exist, commit them with a concise message describing the task: \`git add -A && git commit -m "Implement <short task title>"\`
3. ${rebaseStep}
4. Verify there are commits ahead of the base branch: \`git log origin/${baseBranch}..HEAD --oneline\`
   - **If no commits ahead** (and no uncommitted changes were found in step 1): there is nothing to submit. Run the completion script and stop:
   \`\`\`bash
   tsx ${SCRIPTS_DIR}/complete-pr.ts ${taskId}
   \`\`\`
5. Push to origin. \`--force-with-lease\` because the rebase may have rewritten commits an earlier run already pushed: \`git push --force-with-lease -u origin $(git branch --show-current)\`
6. Create PR with a short specific title and concise summary body. Replace the placeholders with the actual task title and implementation summary:
   \`gh pr create --base ${baseBranch} --title "<short task title>" --body "Summary: <what the task does and how this implementation solves it. Keep this to a short paragraph. Task: #${taskId}>"\``;
}

export async function generatePlanificationMessage(
  taskDocPath: string,
  taskId: number,
  isTechnical: boolean = true,
): Promise<string> {
  const promptName = isTechnical ? 'planification' : 'planification-nontechnical';
  const planTemplatePath = toPromptPath(resolvePromptPath('plan-template'));
  return renderPrompt(promptName, { taskDocPath, taskId, planTemplatePath });
}

export async function generateImplementationMessage(
  taskDocPath: string,
  taskId: number,
): Promise<string> {
  return renderPrompt('implementation', { taskDocPath, taskId });
}

export async function generateReviewMessage(taskDocPath: string, taskId: number): Promise<string> {
  return renderPrompt('review', { taskDocPath, taskId });
}

export async function generateRefinementMessage(
  taskDocPath: string,
  taskId: number,
): Promise<string> {
  return renderPrompt('refinement', { taskDocPath, taskId });
}

export async function generatePrAgentMessage(
  taskDocPath: string,
  taskId: number,
  prUrl: string | null | undefined,
  baseBranch: string,
): Promise<string> {
  const prContextLine = prUrl
    ? `- Existing PR: ${prUrl}`
    : '- No PR exists yet - you need to create one';
  const prCreateOrVerifyBlock = buildPrCreateOrVerifyBlock(taskId, prUrl, baseBranch);
  return renderPrompt('pr', { taskDocPath, taskId, prContextLine, prCreateOrVerifyBlock, baseBranch });
}

export async function generateYoloMessage(
  taskDocPath: string,
  taskId: number,
  prUrl: string | null | undefined,
  baseBranch: string,
): Promise<string> {
  const prContextLine = prUrl
    ? `- Existing PR: ${prUrl}`
    : '- No PR exists yet - you will create one at the end';
  const prCreateOrVerifyBlock = buildPrCreateOrVerifyBlock(taskId, prUrl, baseBranch);
  return renderPrompt('yolo', { taskDocPath, taskId, prContextLine, prCreateOrVerifyBlock, baseBranch });
}

export async function generatePrAgentCommentMessage(
  taskDocPath: string,
  taskId: number,
  prUrl: string | null | undefined,
  webhookContext: CommentWebhookContext,
  baseBranch: string,
): Promise<string> {
  const { commentBody, commentAuthor, fileContext } = webhookContext || {};

  const quotedComment = commentBody
    ? commentBody
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
    : '> (empty comment)';

  let fileLocationSection = '';
  if (fileContext?.path) {
    const lineInfo =
      fileContext.startLine && fileContext.line && fileContext.startLine !== fileContext.line
        ? `lines ${fileContext.startLine}-${fileContext.line}`
        : fileContext.line
          ? `line ${fileContext.line}`
          : '';

    fileLocationSection = `
### Comment Location
- **File**: \`${fileContext.path}\`${lineInfo ? `\n- **Line**: ${lineInfo}` : ''}${fileContext.side ? `\n- **Side**: ${fileContext.side === 'LEFT' ? 'Original code (before changes)' : 'New code (after changes)'}` : ''}
`;

    if (fileContext.diffHunk) {
      fileLocationSection += `
### Code Context (from diff)
\`\`\`diff
${fileContext.diffHunk}
\`\`\`
`;
    }
  }

  const feedbackSection = `## User Feedback
**@${commentAuthor || 'unknown'}** left the following comment on the PR:

${quotedComment}
${fileLocationSection}`;

  return renderPrompt('pr-feedback', { taskDocPath, taskId, prUrl, feedbackSection, baseBranch });
}

export async function generatePrAgentReviewMessage(
  taskDocPath: string,
  taskId: number,
  prUrl: string | null | undefined,
  webhookContext: ReviewWebhookContext,
  baseBranch: string,
): Promise<string> {
  const { reviewBody, reviewAuthor, comments } = webhookContext || {};

  let reviewBodySection = '';
  if (reviewBody) {
    const quotedReview = reviewBody
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    reviewBodySection = `
### Review Summary
**@${reviewAuthor || 'unknown'}** wrote:

${quotedReview}
`;
  }

  let inlineCommentsSection = '';
  if (comments && comments.length > 0) {
    const commentEntries = comments
      .map((c, i) => {
        const { commentBody, commentAuthor, fileContext } = c;
        let entry = `#### ${i + 1}. `;

        if (fileContext?.path) {
          const lineInfo =
            fileContext.startLine &&
            fileContext.line &&
            fileContext.startLine !== fileContext.line
              ? `lines ${fileContext.startLine}-${fileContext.line}`
              : fileContext.line
                ? `line ${fileContext.line}`
                : '';
          entry += `\`${fileContext.path}\`${lineInfo ? ` (${lineInfo})` : ''}`;
        } else {
          entry += 'General comment';
        }

        entry += `\n**@${commentAuthor || 'unknown'}**:`;
        entry += `\n${commentBody || '(empty comment)'}`;

        if (fileContext?.diffHunk) {
          entry += `\n\n<details><summary>Code context (from diff)</summary>\n\n\`\`\`diff\n${fileContext.diffHunk}\n\`\`\`\n</details>`;
        }

        return entry;
      })
      .join('\n\n');

    inlineCommentsSection = `
### Inline Comments (${comments.length})
${commentEntries}
`;
  }

  const feedbackSection = `## User Feedback${reviewBodySection}${inlineCommentsSection}`;

  return renderPrompt('pr-feedback', { taskDocPath, taskId, prUrl, feedbackSection, baseBranch });
}

/**
 * Agent type identifiers
 */
export const AGENT_TYPE = {
  PLANIFICATION: 'planification',
  IMPLEMENTATION: 'implementation',
  REFINEMENT: 'refinement',
  REVIEW: 'review',
  PR: 'pr',
} as const;
