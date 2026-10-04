// Request/response shapes for the project endpoints:
//  - /api/projects/*                    (CRUD)
//  - /api/projects/:id/upload
//  - /api/projects/:id/web-server*      (mounted via webServer.js)
//  - /api/projects/:id/files            (inline handler in server/index.js)

import type { AgentType, ProjectRow } from '../types/db';
import { expectType } from './_common';

// ---- Project CRUD ---------------------------------------------------------
//
// `getAllProjects(userId)` and `getProject(id, userId)` return raw
// `ProjectRow` shapes — there is no `task_counts` decoration today, despite
// what the earlier docs implied. If we ever add aggregation, define a
// `ProjectListItem` with `Pick<ProjectRow, …> & { task_counts: ... }` and
// migrate ListProjectsResponse to that.

export type ListProjectsResponse = ProjectRow[];

export type GetProjectResponse = ProjectRow;

export interface CreateProjectRequest {
  name: string;
  repoFolderPath: string;
  subprojectPath?: string;
}

export type CreateProjectResponse = ProjectRow;

export interface UpdateProjectRequest {
  name?: string | undefined;
  repoFolderPath?: string | undefined;
  subprojectPath?: string | undefined;
}

export type UpdateProjectResponse = ProjectRow;

export interface DeleteProjectResponse {
  success: true;
}

// ---- Files ----------------------------------------------------------------

// `/api/projects/:id/files` returns the file tree used by `@`-mention
// completion. The handler lives inline in `server/index.js`; the shape
// is one entry per file under the repo (subset suitable for autocomplete).
export interface ProjectFile {
  path: string;
  name: string;
  type: 'file' | 'directory';
}

export type GetProjectFilesResponse = ProjectFile[];

// ---- Upload ---------------------------------------------------------------
//
// Multipart upload to `tmp/`. The success body wraps a typed `file` shape
// produced by `saveConversationUpload()` — note `absolutePath` /
// `relativePath` are deliberate (consumers reference files by relative
// path in subsequent prompts).

export interface UploadedFile {
  name: string;
  absolutePath: string;
  relativePath: string;
  size: number;
  mimeType: string;
}

export interface UploadProjectFileResponse {
  success: true;
  file: UploadedFile;
}

// ---- Web server (mounted under projects) ----------------------------------
//
// Returns from the `webServerManager` service. The success/error envelope
// is reused across all four endpoints so the shape on the wire mixes
// success/failure fields. Consumers should branch on `success`.

export interface WebServerStatusSuccess {
  success: true;
  activeTaskId: number | null;
  serveSymlinkPath: string | null;
  systemdServiceName: string | null;
  // Public URL of the deployed app; opened in a new tab after a successful
  // switch. `null` (or empty) means "don't open a tab".
  appUrl: string | null;
  isConfigured: boolean;
}

export interface WebServerStatusError {
  success: false;
  error: string;
}

export type GetWebServerResponse = WebServerStatusSuccess | WebServerStatusError;

export interface UpdateWebServerConfigRequest {
  serveSymlinkPath?: string | undefined;
  systemdServiceName?: string | undefined;
  appUrl?: string | undefined;
}

export type UpdateWebServerConfigResponse =
  | { success: true; project: ProjectRow }
  | { success: false; error: string };

export interface SwitchWebServerRequest {
  // `null` switches back to the main repo; a number switches to that
  // task's worktree.
  taskId: number | null;
}

export type SwitchWebServerResponse =
  | {
      success: true;
      activeTaskId: number | null;
      // Present when the symlink updated but the systemd restart warned.
      warning?: string;
    }
  | { success: false; error: string };

export interface VerifyWebServerSuccess {
  success: true;
  matches: boolean;
  expectedTarget: string;
  actualTarget: string | null;
  symlinkExists: boolean;
  // Set when the symlink doesn't exist on disk but we still return 200.
  error?: string;
}

export interface VerifyWebServerError {
  success: false;
  error: string;
}

export type VerifyWebServerResponse = VerifyWebServerSuccess | VerifyWebServerError;

// ---- Type-level smoke checks ---------------------------------------------

expectType<ListProjectsResponse>([] as ProjectRow[]);
expectType<GetProjectResponse>({} as ProjectRow);

// ---- Project bootstrap (extra/project-bootstrap.md) ------------------------
//
// `GET /api/projects/:id/bootstrap` fetches `origin/<default>` and reports
// whether PRD.md / ARD.md are on it; `stale` means the fetch failed and the
// local default branch was read instead. `POST /api/projects/:id/bootstrap/:kind`
// starts a PRD / ARD / task-breakdown chat session.

export type BootstrapKind = 'prd' | 'ard' | 'tasks';

export type BootstrapMode = 'create' | 'refine';

export interface BootstrapStatusResponse {
  /** `null` when the project folder is not a git repository. */
  defaultBranch: string | null;
  isGitRepository: boolean;
  prd: { onMain: boolean };
  ard: { onMain: boolean };
  stale: boolean;
}

export interface StartBootstrapRequest {
  input?: string | undefined;
  provider: 'anthropic' | 'openai' | 'opencode';
  model: string;
}

export interface StartBootstrapResponse {
  taskId: number;
  conversationId: number;
  /** The rendered prompt sent as the first user message (shown while streaming). */
  initialMessage: string;
}

// ---- Autopilot (extra/autopilot.md) -----------------------------------------
//
// `GET /api/projects/:id/autopilot` — the switch plus what it would do next.
// `PUT /api/projects/:id/autopilot` — `{ enabled }`, returns the status.
// `POST /api/projects/:id/autopilot/start` — start the next ready task; 409
// with `error` when nothing was started (off, busy, running, nothing ready).

export interface AutopilotTaskRef {
  taskId: number;
  title: string | null;
}

export interface AutopilotStatusResponse {
  enabled: boolean;
  isGitRepository: boolean;
  running: (AutopilotTaskRef & { agentType: AgentType }) | null;
  /** What Start would pick. */
  next: AutopilotTaskRef | null;
  readyCount: number;
  /** Pending tasks whose dependencies aren't completed. */
  waitingCount: number;
  /** Started tasks with `workflow_blocked`. */
  blockedCount: number;
  /** The last start/merge/stop message. */
  message: string | null;
}

export interface SetAutopilotRequest {
  enabled: boolean;
}

export interface StartAutopilotResponse {
  taskId: number;
  /** The agent started, or `finish` when the task only needed merging. */
  step: AgentType | 'finish';
}
