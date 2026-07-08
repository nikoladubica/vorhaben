// Typed Markdown-journal API calls built on the shared `api` helper. The helper already handles
// credentials, JSON, and ApiError (with the `fields` map — 422 title, 413 body_md too_long) —
// see client/src/api.ts.
//
// Nested reads/creates live under /projects/:id/notes; single-note PATCH/DELETE use the flat
// /notes/:id paths (see server/src/routes/notes.ts). `body_md` travels verbatim in both
// directions — the server never touches it, so safe rendering is the client's job.

import { api } from '../api';
import type { Note, NoteInput } from '../types';

export function listNotes(projectId: number): Promise<Note[]> {
  return api.get<Note[]>(`/projects/${projectId}/notes`);
}

export function createNote(projectId: number, input: NoteInput): Promise<Note> {
  return api.post<Note>(`/projects/${projectId}/notes`, input);
}

export function updateNote(id: number, input: Partial<NoteInput>): Promise<Note> {
  return api.patch<Note>(`/notes/${id}`, input);
}

export function deleteNote(id: number): Promise<void> {
  return api.del<void>(`/notes/${id}`);
}
