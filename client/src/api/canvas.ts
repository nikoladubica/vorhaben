// Typed canvas API calls built on the shared `api` helper. The helper already handles credentials,
// JSON, and ApiError — see client/src/api.ts. The canvas is a spatial layer over the projects: it
// never changes their numbers, only where a card sits and whether it is on the board at all.

import { api } from '../api';
import type { CanvasBoard, LinkType, ProjectLink } from '../types';

// The whole board: cards already placed (with x/y) plus the tray of unplaced projects.
export function getCanvas(): Promise<CanvasBoard> {
  return api.get<CanvasBoard>('/canvas');
}

// Upsert a card's board position (integers ≥ 0, snapped to the 24px grid by the caller). Reviving a
// previously-removed card is the same call. Returns the persisted coordinates.
export function placeProject(
  projectId: number,
  x: number,
  y: number,
): Promise<{ project_id: number; x: number; y: number }> {
  return api.put<{ project_id: number; x: number; y: number }>(`/canvas/${projectId}`, { x, y });
}

// Take a card off the board (back to the tray). The project itself is untouched — 204 No Content.
export function removeFromBoard(projectId: number): Promise<void> {
  return api.del<void>(`/canvas/${projectId}`);
}

// Connect two projects with a typed relationship (drawn on the board, stored as a real link). The id
// comes from the server, so the page POSTs first and appends on success. Rejections surface as
// ApiError: 409 `link_exists` (already connected either direction), 422 `validation` (cycle / bad
// input). Reviving a previously-removed pair is the same call — the server upserts on the unique key.
export function createLink(
  from_project_id: number,
  to_project_id: number,
  type: LinkType,
): Promise<ProjectLink> {
  return api.post<ProjectLink>('/canvas/links', { from_project_id, to_project_id, type });
}

// Change an existing connection's type in place (parent ⇄ blocks). Direction is fixed — changing it
// is remove + redraw. Returns the updated link row.
export function updateLinkType(id: number, type: LinkType): Promise<ProjectLink> {
  return api.patch<ProjectLink>(`/canvas/links/${id}`, { type });
}

// Remove a connection — soft-deletes the link row (never hard-deleted). 204 No Content.
export function deleteLink(id: number): Promise<void> {
  return api.del<void>(`/canvas/links/${id}`);
}
