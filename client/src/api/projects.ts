// Typed project API calls built on the shared `api` helper. The helper already handles
// credentials, JSON, and ApiError (with the 422 `fields` map) — see client/src/api.ts.

import { api } from '../api';
import type { Project, ProjectPayload, ProjectType } from '../types';

export interface ProjectFilters {
  status?: string;
  type?: string;
  tag?: string;
}

// Build a querystring from the filters, omitting empty values.
function buildQuery(filters: ProjectFilters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.type) params.set('type', filters.type);
  if (filters.tag) params.set('tag', filters.tag);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function listProjects(filters: ProjectFilters = {}): Promise<Project[]> {
  return api.get<Project[]>(`/projects${buildQuery(filters)}`);
}

export function getProject(id: number): Promise<Project> {
  return api.get<Project>(`/projects/${id}`);
}

export function createProject(payload: ProjectPayload): Promise<Project> {
  return api.post<Project>('/projects', payload);
}

export function updateProject(
  id: number,
  payload: ProjectPayload,
): Promise<Project> {
  return api.patch<Project>(`/projects/${id}`, payload);
}

export function softDeleteProject(id: number): Promise<void> {
  return api.del<void>(`/projects/${id}`);
}

export function restoreProject(id: number): Promise<Project> {
  return api.post<Project>(`/projects/${id}/restore`);
}

export function listProjectTypes(): Promise<ProjectType[]> {
  return api.get<ProjectType[]>('/project-types');
}
