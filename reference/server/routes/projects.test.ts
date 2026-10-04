import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

// Mock the database module
vi.mock('../database/db.js', () => ({
  projectsDb: {
    create: vi.fn(),
    getById: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    setAutopilotEnabled: vi.fn(),
    setAutopilotMessage: vi.fn()
  }
}));

vi.mock('../services/autopilot.js', () => ({
  getAutopilotStatus: vi.fn(),
  startNextAutopilotTask: vi.fn(),
}));

// Mock the projectService
vi.mock('../services/projectService.js', () => ({
  getAllProjects: vi.fn(),
  getProject: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn()
}));

// Mock the documentation service
vi.mock('../services/documentation.js', () => ({
  saveConversationUpload: vi.fn()
}));

// Mock the upload middleware (no size/extension restrictions)
vi.mock('../middleware/upload.js', async () => {
  const multer = await import('multer');
  return {
    MulterError: multer.default.MulterError,
    upload: multer.default({ storage: multer.default.memoryStorage() })
  };
});

// Mock the bootstrap service (real error classes, mocked I/O)
vi.mock('../services/projectBootstrap.js', () => {
  class BootstrapRequestError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    BootstrapRequestError,
    getBootstrapStatus: vi.fn(),
    startBootstrapSession: vi.fn(),
  };
});

import projectsRoutes from './projects.js';
import {
  BootstrapRequestError,
  getBootstrapStatus,
  startBootstrapSession,
} from '../services/projectBootstrap.js';
import { ProviderCredentialsMissingError } from '../services/credentials/types.js';
import { getAutopilotStatus, startNextAutopilotTask } from '../services/autopilot.js';
import { projectsDb } from '../database/db.js';
import { getAllProjects, getProject, updateProject, deleteProject } from '../services/projectService.js';
import { saveConversationUpload } from '../services/documentation.js';

describe('Projects Routes - Phase 3', () => {
  let app: import("express").Application;
  const testUserId = 1;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Create Express app with mocked auth
    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { id: testUserId, username: 'testuser' } as never;
      next();
    });
    app.use('/api/projects', projectsRoutes);
  });

  describe('GET /api/projects', () => {
    it('should return all projects for the user', async () => {
      const mockProjects = [
        { id: 1, user_id: testUserId, name: 'Project 1', repo_folder_path: '/path/1' },
        { id: 2, user_id: testUserId, name: 'Project 2', repo_folder_path: '/path/2' }
      ];
      vi.mocked(getAllProjects).mockReturnValue(mockProjects as never);

      const response = await request(app).get('/api/projects');

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockProjects);
      expect(getAllProjects).toHaveBeenCalledWith(testUserId);
    });

    it('should return empty array when no projects', async () => {
      vi.mocked(getAllProjects).mockReturnValue([]);

      const response = await request(app).get('/api/projects');

      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
    });
  });

  describe('POST /api/projects', () => {
    it('should create a new project', async () => {
      const newProject = { id: 1, userId: testUserId, name: 'New Project', repoFolderPath: '/path/new' };
      vi.mocked(projectsDb.create).mockReturnValue(newProject as never);

      const response = await request(app)
        .post('/api/projects')
        .send({ name: 'New Project', repoFolderPath: '/path/new' });

      expect(response.status).toBe(201);
      expect(response.body).toEqual(newProject);
      expect(projectsDb.create).toHaveBeenCalledWith(testUserId, 'New Project', '/path/new', null);
    });

    it('should return 400 if name is missing', async () => {
      const response = await request(app)
        .post('/api/projects')
        .send({ repoFolderPath: '/path/new' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(Array.isArray(response.body.issues)).toBe(true);
    });

    it('should return 400 if repoFolderPath is missing', async () => {
      const response = await request(app)
        .post('/api/projects')
        .send({ name: 'New Project' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(Array.isArray(response.body.issues)).toBe(true);
    });

    it('should return 409 on duplicate repo path', async () => {
      vi.mocked(projectsDb.create).mockImplementation(() => {
        const error = new Error('UNIQUE constraint failed') as Error & { code: string };
        error.code = 'SQLITE_CONSTRAINT_UNIQUE';
        throw error;
      });

      const response = await request(app)
        .post('/api/projects')
        .send({ name: 'New Project', repoFolderPath: '/path/existing' });

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('A project with this repository path already exists');
    });
  });

  describe('GET /api/projects/:id', () => {
    it('should return a project by ID', async () => {
      const mockProject = { id: 1, user_id: testUserId, name: 'Project 1', repo_folder_path: '/path/1' };
      vi.mocked(getProject).mockReturnValue(mockProject as never);

      const response = await request(app).get('/api/projects/1');

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockProject);
      expect(getProject).toHaveBeenCalledWith(1, testUserId);
    });

    it('should return 404 if project not found', async () => {
      vi.mocked(getProject).mockReturnValue(undefined);

      const response = await request(app).get('/api/projects/999');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Project not found');
    });

    it('should return 400 for invalid ID', async () => {
      const response = await request(app).get('/api/projects/invalid');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
    });
  });

  describe('PUT /api/projects/:id', () => {
    it('should update a project', async () => {
      const updatedProject = { id: 1, user_id: testUserId, name: 'Updated Name', repo_folder_path: '/path/1' };
      vi.mocked(updateProject).mockReturnValue(updatedProject as never);

      const response = await request(app)
        .put('/api/projects/1')
        .send({ name: 'Updated Name' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual(updatedProject);
      expect(updateProject).toHaveBeenCalledWith(1, testUserId, { name: 'Updated Name' });
    });

    it('should return 404 if project not found', async () => {
      vi.mocked(updateProject).mockReturnValue(null);

      const response = await request(app)
        .put('/api/projects/999')
        .send({ name: 'Updated Name' });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Project not found');
    });
  });

  describe('DELETE /api/projects/:id', () => {
    it('should delete a project', async () => {
      vi.mocked(deleteProject).mockReturnValue(true);

      const response = await request(app).delete('/api/projects/1');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
      expect(deleteProject).toHaveBeenCalledWith(1, testUserId);
    });

    it('should return 404 if project not found', async () => {
      vi.mocked(deleteProject).mockReturnValue(false);

      const response = await request(app).delete('/api/projects/999');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Project not found');
    });
  });

  describe('POST /api/projects/:id/upload', () => {
    it('should upload file and return file info', async () => {
      const mockProject = { id: 1, user_id: testUserId, repo_folder_path: '/path/to/project' };
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(saveConversationUpload).mockReturnValue({
        name: 'test.txt',
        absolutePath: '/path/to/project/tmp/test.txt',
        relativePath: './tmp/test.txt',
        size: 12,
        mimeType: 'text/plain'
      });

      const response = await request(app)
        .post('/api/projects/1/upload')
        .attach('file', Buffer.from('test content'), 'test.txt');

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.file.relativePath).toBe('./tmp/test.txt');
      expect(saveConversationUpload).toHaveBeenCalledWith(
        '/path/to/project',
        'test.txt',
        expect.any(Buffer)
      );
    });

    it('should return 404 if project not found', async () => {
      vi.mocked(getProject).mockReturnValue(undefined);

      const response = await request(app)
        .post('/api/projects/999/upload')
        .attach('file', Buffer.from('content'), 'test.txt');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Project not found');
    });

    it('should return 400 if no file provided', async () => {
      const mockProject = { id: 1, user_id: testUserId, repo_folder_path: '/path/to/project' };
      vi.mocked(getProject).mockReturnValue(mockProject as never);

      const response = await request(app)
        .post('/api/projects/1/upload')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('No file provided');
    });

    it('should return 400 for invalid project ID', async () => {
      const response = await request(app)
        .post('/api/projects/invalid/upload')
        .attach('file', Buffer.from('content'), 'test.txt');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
    });

    it('should accept any file type including xlsx', async () => {
      const mockProject = { id: 1, user_id: testUserId, repo_folder_path: '/path/to/project' };
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(saveConversationUpload).mockReturnValue({
        name: 'data.xlsx',
        absolutePath: '/path/to/project/tmp/data.xlsx',
        relativePath: './tmp/data.xlsx',
        size: 1024,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      });

      const response = await request(app)
        .post('/api/projects/1/upload')
        .attach('file', Buffer.from('xlsx content'), 'data.xlsx');

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.file.relativePath).toBe('./tmp/data.xlsx');
    });
  });

  describe('GET /api/projects/:id/bootstrap', () => {
    it('returns the status without the internal base ref', async () => {
      vi.mocked(getProject).mockReturnValue({ id: 1, repo_folder_path: '/repo' } as never);
      vi.mocked(getBootstrapStatus).mockResolvedValue({
        defaultBranch: 'main',
        baseRef: 'origin/main',
        isGitRepository: true,
        prd: { onMain: true },
        ard: { onMain: false },
        stale: false,
      });

      const response = await request(app).get('/api/projects/1/bootstrap');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        defaultBranch: 'main',
        isGitRepository: true,
        prd: { onMain: true },
        ard: { onMain: false },
        stale: false,
      });
      expect(getBootstrapStatus).toHaveBeenCalledWith('/repo');
    });

    it('returns 404 for a non-member', async () => {
      vi.mocked(getProject).mockReturnValue(undefined);

      const response = await request(app).get('/api/projects/1/bootstrap');

      expect(response.status).toBe(404);
      expect(getBootstrapStatus).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/projects/:id/bootstrap/:kind', () => {
    const project = { id: 1, repo_folder_path: '/repo', subproject_path: null };

    it('starts a session and returns the ids', async () => {
      vi.mocked(getProject).mockReturnValue(project as never);
      vi.mocked(startBootstrapSession).mockResolvedValue({ taskId: 5, conversationId: 9, initialMessage: 'hi' });

      const response = await request(app)
        .post('/api/projects/1/bootstrap/prd')
        .send({ input: 'A meal ordering app', provider: 'anthropic', model: 'opus' });

      expect(response.status).toBe(201);
      expect(response.body).toEqual({ taskId: 5, conversationId: 9, initialMessage: 'hi' });
      expect(startBootstrapSession).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'prd',
          project,
          userId: testUserId,
          input: 'A meal ordering app',
          provider: 'anthropic',
          model: 'opus',
        }),
      );
    });

    it('rejects an unknown kind, a missing model, and a model from another provider', async () => {
      vi.mocked(getProject).mockReturnValue(project as never);

      const badKind = await request(app)
        .post('/api/projects/1/bootstrap/docs')
        .send({ provider: 'anthropic', model: 'opus' });
      const noModel = await request(app)
        .post('/api/projects/1/bootstrap/ard')
        .send({ provider: 'anthropic' });
      const wrongModel = await request(app)
        .post('/api/projects/1/bootstrap/ard')
        .send({ provider: 'anthropic', model: 'gpt-5.5' });

      expect(badKind.status).toBe(400);
      expect(noModel.status).toBe(400);
      expect(wrongModel.status).toBe(400);
      expect(startBootstrapSession).not.toHaveBeenCalled();
    });

    it('returns 404 for a non-member', async () => {
      vi.mocked(getProject).mockReturnValue(undefined);

      const response = await request(app)
        .post('/api/projects/1/bootstrap/tasks')
        .send({ provider: 'anthropic', model: 'opus' });

      expect(response.status).toBe(404);
      expect(startBootstrapSession).not.toHaveBeenCalled();
    });

    it('returns 409 when a prerequisite is missing', async () => {
      vi.mocked(getProject).mockReturnValue(project as never);
      vi.mocked(startBootstrapSession).mockRejectedValue(
        new BootstrapRequestError(409, 'ARD.md must be merged into main before creating initial tasks'),
      );

      const response = await request(app)
        .post('/api/projects/1/bootstrap/tasks')
        .send({ provider: 'anthropic', model: 'opus' });

      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/ARD.md must be merged/);
    });

    it('returns 403 PROVIDER_CREDENTIALS_MISSING when the provider is not connected', async () => {
      vi.mocked(getProject).mockReturnValue(project as never);
      vi.mocked(startBootstrapSession).mockRejectedValue(
        new ProviderCredentialsMissingError('openai', 'no token'),
      );

      const response = await request(app)
        .post('/api/projects/1/bootstrap/ard')
        .send({ provider: 'openai', model: 'gpt-5.5' });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('PROVIDER_CREDENTIALS_MISSING');
      expect(response.body.provider).toBe('openai');
    });
  });

  describe('autopilot', () => {
    const project = { id: 1, repo_folder_path: '/repo', autopilot_enabled: 0 };
    const status = {
      enabled: true,
      isGitRepository: true,
      running: null,
      next: { taskId: 4, title: '1. Scaffold' },
      readyCount: 1,
      waitingCount: 2,
      blockedCount: 0,
      message: null,
    };

    it('GET returns the status, 404 for a project without access', async () => {
      vi.mocked(getProject).mockReturnValue(project as never);
      vi.mocked(getAutopilotStatus).mockResolvedValue(status as never);

      const response = await request(app).get('/api/projects/1/autopilot');
      expect(response.status).toBe(200);
      expect(response.body).toEqual(status);

      vi.mocked(getProject).mockReturnValue(null as never);
      expect((await request(app).get('/api/projects/1/autopilot')).status).toBe(404);
    });

    it('PUT toggles the switch, clears the message and validates the body', async () => {
      vi.mocked(getProject).mockReturnValue(project as never);
      vi.mocked(getAutopilotStatus).mockResolvedValue(status as never);

      const response = await request(app).put('/api/projects/1/autopilot').send({ enabled: true });
      expect(response.status).toBe(200);
      expect(projectsDb.setAutopilotEnabled).toHaveBeenCalledWith(1, true);
      expect(projectsDb.setAutopilotMessage).toHaveBeenCalledWith(1, null);

      const bad = await request(app).put('/api/projects/1/autopilot').send({ enabled: 'yes' });
      expect(bad.status).toBe(400);
    });

    it('POST start returns the started task and step', async () => {
      vi.mocked(getProject).mockReturnValue(project as never);
      vi.mocked(startNextAutopilotTask).mockResolvedValue({ status: 'started', taskId: 4, step: 'planification' });

      const response = await request(app).post('/api/projects/1/autopilot/start');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ taskId: 4, step: 'planification' });
      expect(startNextAutopilotTask).toHaveBeenCalledWith(1, expect.objectContaining({ userId: testUserId }));
    });

    it('POST start returns 409 with the reason when nothing started', async () => {
      vi.mocked(getProject).mockReturnValue(project as never);
      vi.mocked(startNextAutopilotTask).mockResolvedValue({ status: 'idle', message: 'Done: no tasks left to run.' });

      const response = await request(app).post('/api/projects/1/autopilot/start');

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('Done: no tasks left to run.');
    });

    it('POST start maps missing credentials to 403', async () => {
      vi.mocked(getProject).mockReturnValue(project as never);
      vi.mocked(startNextAutopilotTask).mockRejectedValue(new ProviderCredentialsMissingError('anthropic', 'x'));

      const response = await request(app).post('/api/projects/1/autopilot/start');

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('PROVIDER_CREDENTIALS_MISSING');
    });
  });
});
