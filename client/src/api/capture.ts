// Typed voice-capture API calls built on the shared `api` helper (credentials, JSON, ApiError with
// the 422 `fields` map — see client/src/api.ts). Backend routes live in server/src/routes/{voice,
// checklists,reminders,events}.ts. The rules parser and the optional LLM path both return the same
// ParsedDraft shape; nothing here persists until the user confirms a Save.

import { api } from '../api';

// ————— capture kinds & the parse draft —————

export type CaptureKind = 'checklist' | 'note' | 'reminder' | 'event';

// Result of POST /voice/parse — an editable draft, never a saved row. `datetime` is a local,
// timezone-naive ISO string ("2026-07-10T17:00:00") that binds straight to <input type=datetime-local>.
// `source` labels which path produced it (rules always available; llm when a key is configured).
export interface ParsedDraft {
  kind: CaptureKind;
  kindConfidence: 'explicit' | 'inferred';
  title: string;
  items: string[];
  body: string;
  datetime: string | null;
  dateSuggestion: boolean;
  projectId: number | null;
  source: 'rules' | 'llm';
}

// ————— persisted rows —————

export interface ChecklistItem {
  id: number;
  text: string;
  checked: boolean;
  position: number;
}

export interface Checklist {
  id: number;
  project_id: number | null;
  title: string;
  source_transcript: string | null;
  created_at: string;
  updated_at: string;
  items: ChecklistItem[];
  item_count: number;
  checked_count: number;
}

export type ReminderStatus = 'pending' | 'done' | 'dismissed';

export interface Reminder {
  id: number;
  project_id: number | null;
  text: string;
  remind_at: string | null;
  status: ReminderStatus;
  source_transcript: string | null;
  created_at: string;
  updated_at: string;
}

export interface CaptureEvent {
  id: number;
  project_id: number | null;
  title: string;
  starts_at: string;
  source_transcript: string | null;
  created_at: string;
  updated_at: string;
}

// ————— voice endpoints —————

export function getCapabilities(): Promise<{ llm: boolean }> {
  return api.get<{ llm: boolean }>('/voice/capabilities');
}

// Side-effect free: parses the transcript into a draft. Never writes.
export function parseTranscript(transcript: string): Promise<ParsedDraft> {
  return api.post<ParsedDraft>('/voice/parse', { transcript });
}

// ————— checklists —————

export interface ChecklistInput {
  title: string;
  project_id?: number | null;
  source_transcript?: string | null;
  items: { text: string }[];
}

export function listChecklists(projectId?: number): Promise<Checklist[]> {
  const qs = projectId != null ? `?project_id=${projectId}` : '';
  return api.get<Checklist[]>(`/checklists${qs}`);
}

export function createChecklist(input: ChecklistInput): Promise<Checklist> {
  return api.post<Checklist>('/checklists', input);
}

export function deleteChecklist(id: number): Promise<void> {
  return api.del<void>(`/checklists/${id}`);
}

// The check/uncheck endpoint (also renames item text).
export function updateChecklistItem(
  id: number,
  input: { checked?: boolean; text?: string },
): Promise<ChecklistItem & { checklist_id: number }> {
  return api.patch<ChecklistItem & { checklist_id: number }>(`/checklist-items/${id}`, input);
}

// ————— reminders (one endpoint serves both the voice review flow and the manual form) —————

export interface ReminderInput {
  text: string;
  remind_at?: string | null;
  project_id?: number | null;
  source_transcript?: string | null;
}

export function listReminders(status?: ReminderStatus): Promise<Reminder[]> {
  const qs = status ? `?status=${status}` : '';
  return api.get<Reminder[]>(`/reminders${qs}`);
}

export function createReminder(input: ReminderInput): Promise<Reminder> {
  return api.post<Reminder>('/reminders', input);
}

export function updateReminder(
  id: number,
  input: { status?: ReminderStatus; text?: string; remind_at?: string | null },
): Promise<Reminder> {
  return api.patch<Reminder>(`/reminders/${id}`, input);
}

export function deleteReminder(id: number): Promise<void> {
  return api.del<void>(`/reminders/${id}`);
}

// ————— events —————

export interface EventInput {
  title: string;
  starts_at: string;
  project_id?: number | null;
  source_transcript?: string | null;
}

export function listEvents(): Promise<CaptureEvent[]> {
  return api.get<CaptureEvent[]>('/events');
}

export function createEvent(input: EventInput): Promise<CaptureEvent> {
  return api.post<CaptureEvent>('/events', input);
}

export function deleteEvent(id: number): Promise<void> {
  return api.del<void>(`/events/${id}`);
}

// ————— note save (reuses the existing per-project notes route, now accepting source_transcript) —————

export interface CaptureNoteInput {
  title: string;
  body_md: string;
  source_transcript?: string | null;
}

export function createNoteFromCapture(
  projectId: number,
  input: CaptureNoteInput,
): Promise<{ id: number; project_id: number; title: string }> {
  return api.post<{ id: number; project_id: number; title: string }>(
    `/projects/${projectId}/notes`,
    input,
  );
}
