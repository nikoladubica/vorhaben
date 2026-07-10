// Typed project API calls built on the shared `api` helper. The helper already handles
// credentials, JSON, and ApiError (with the 422 `fields` map) — see client/src/api.ts.

import { api } from '../api';
import type {
  Feeling,
  Project,
  ProjectMetrics,
  ProjectPayload,
  ProjectType,
  ProjectWithMetrics,
  Trend,
} from '../types';

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

export function listProjects(filters: ProjectFilters = {}): Promise<ProjectWithMetrics[]> {
  return api.get<ProjectWithMetrics[]>(`/projects${buildQuery(filters)}`);
}

export function getProject(id: number): Promise<Project> {
  return api.get<Project>(`/projects/${id}`);
}

export function createProject(payload: ProjectPayload): Promise<Project> {
  return api.post<Project>('/projects', payload);
}

export function updateProject(id: number, payload: ProjectPayload): Promise<Project> {
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

// Canvas annotations (screen 14). Each is a thin PATCH that sets — or clears, with null — one of the
// two feeling/trend fields; the server validates the closed lists (invalid → 422 fields.feeling /
// fields.trend). Neither touches the project's numbers. Returns the updated project.
export function setProjectFeeling(id: number, feeling: Feeling | null): Promise<Project> {
  return api.patch<Project>(`/projects/${id}`, { feeling });
}

export function setProjectTrend(id: number, trend: Trend | null): Promise<Project> {
  return api.patch<Project>(`/projects/${id}`, { trend });
}

// The project's normalized headline figures (§2.2 / §8) for the detail-screen summary — same
// canonical trailing-3-month window as the dashboard, in the user's base currency.
export function getProjectMetrics(id: number): Promise<ProjectMetrics> {
  return api.get<ProjectMetrics>(`/projects/${id}/metrics`);
}
