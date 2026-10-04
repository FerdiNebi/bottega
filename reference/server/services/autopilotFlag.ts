// The autopilot switch (extra/autopilot.md), in its own module so the
// conversation layer can read it without importing agentRunner/autopilot
// (which would close an import cycle through startConversation).

import { projectsDb } from '../database/db.js';

export function isAutopilotProject(projectId: number): boolean {
  return projectsDb.getByIdAdmin(projectId)?.autopilot_enabled === 1;
}
