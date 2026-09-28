// Runtime validation schemas for the `/api/projects/*` routes
// (`server/routes/projects.ts`).

import { z } from 'zod';
import { isModelForProvider } from '../providers/models.js';

export const CreateProjectBodySchema = z.object({
  name: z.string().trim().min(1, 'Project name is required'),
  repoFolderPath: z
    .string()
    .trim()
    .min(1, 'Repository folder path is required'),
  subprojectPath: z.string().optional(),
});
export type CreateProjectBody = z.infer<typeof CreateProjectBodySchema>;

export const UpdateProjectBodySchema = z.object({
  name: z.string().optional(),
  repoFolderPath: z.string().optional(),
  // The DB layer accepts `null` to clear the column, and the existing
  // type `UpdateProjectRequest` allows `undefined`. Be permissive here.
  subprojectPath: z.string().nullable().optional(),
});
export type UpdateProjectBody = z.infer<typeof UpdateProjectBodySchema>;

// ---- Project bootstrap ----------------------------------------------------

export const BootstrapParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  kind: z.enum(['prd', 'ard', 'tasks']),
});
export type BootstrapParams = z.infer<typeof BootstrapParamsSchema>;

// `(provider, model)` is explicit and validated like conversation creation;
// there is no default model.
export const StartBootstrapBodySchema = z
  .object({
    input: z.string().max(20_000).optional(),
    provider: z.enum(['anthropic', 'openai', 'opencode']),
    model: z.string().min(1),
  })
  .refine((b) => isModelForProvider(b.provider, b.model), {
    message: 'model does not belong to the selected provider',
    path: ['model'],
  });
export type StartBootstrapBody = z.infer<typeof StartBootstrapBodySchema>;
