// Tag-management calls built on the shared `api` helper (credentials, JSON, and ApiError are
// handled there — see client/src/api.ts).

import { api } from '../api';

// One tag with the number of (non-deleted) projects it labels.
export interface Tag {
  id: number;
  name: string;
  project_count: number;
}

export function listTags(): Promise<Tag[]> {
  return api.get<Tag[]>('/tags');
}

// Rename a tag. If the new name collides with another tag the server merges them, so the caller
// should refresh the whole list rather than patch a single row.
export function renameTag(id: number, name: string): Promise<Tag> {
  return api.patch<Tag>(`/tags/${id}`, { name });
}

export function deleteTag(id: number): Promise<void> {
  return api.del<void>(`/tags/${id}`);
}
