// Voice / quick capture (design screen 15). A push-to-talk mic (Web Speech API, browser-only
// transcription — no audio leaves the page) turns speech into an editable draft that the user
// reviews before anything is saved. Firefox has no SpeechRecognition, so the mic is swapped for a
// textarea feeding the same parse → review → save pipeline. Reminders are dual-entry: the manual
// "New reminder" form below depends on nothing voice-related (no mic, no parse, no LLM).

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../api';
import type { Project } from '../types';
import { listProjects } from '../api/projects';
import {
  createChecklist,
  createEvent,
  createNoteFromCapture,
  createReminder,
  deleteChecklist,
  deleteEvent,
  deleteReminder,
  getCapabilities,
  listChecklists,
  listEvents,
  listReminders,
  parseTranscript,
  updateReminder,
} from '../api/capture';
import type {
  CaptureEvent,
  CaptureKind,
  Checklist,
  ParsedDraft,
  Reminder,
} from '../api/capture';
import { ChecklistView } from '../components/ChecklistView';
import { useSpeechRecognition } from '../voice/useSpeechRecognition';
import './capture.css';

// ————— draft model (local, editable — never a saved row until Save) —————

interface DraftItem {
  text: string;
  checked: boolean;
}
interface Draft {
  kind: CaptureKind;
  title: string;
  items: DraftItem[];
  body: string;
  datetime: string; // datetime-local value ("YYYY-MM-DDTHH:MM") or ''
  dateSuggestion: boolean;
  projectId: number | null;
  source: 'rules' | 'llm';
  transcript: string;
}

const KIND_LABELS: Record<CaptureKind, string> = {
  checklist: 'Checklist',
  note: 'Note',
  reminder: 'Reminder',
  event: 'Event',
};

// Server datetimes are local wall-clock with seconds ("2026-07-10T17:00:00"); datetime-local wants
// no seconds. The server accepts either on the way back, so this is the only conversion needed.
function toInputDateTime(iso: string | null): string {
  if (!iso) return '';
  return iso.length >= 16 ? iso.slice(0, 16) : iso;
}

function formatWhen(iso: string | null): string {
  if (!iso) return 'Undated';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function draftFromParsed(p: ParsedDraft, transcript: string): Draft {
  return {
    kind: p.kind,
    title: p.title,
    items: p.items.map((t) => ({ text: t, checked: false })),
    body: p.body,
    datetime: toInputDateTime(p.datetime),
    dateSuggestion: p.dateSuggestion,
    projectId: p.projectId,
    source: p.source,
    transcript,
  };
}

// Switching kind remaps fields locally — no re-parse. Items fold into a bulleted note body and a
// note body unfolds back into items, so nothing the user dictated is lost across a switch.
function changeKind(d: Draft, next: CaptureKind): Draft {
  if (d.kind === next) return d;
  let { items, body } = d;
  if (next === 'checklist' && items.length === 0 && body.trim()) {
    items = body
      .split('\n')
      .map((l) => l.replace(/^\s*[-*]\s+/, '').trim())
      .filter(Boolean)
      .map((text) => ({ text, checked: false }));
  }
  if (next === 'note' && !body.trim() && items.length > 0) {
    body = items
      .filter((i) => i.text.trim())
      .map((i) => `- ${i.text.trim()}`)
      .join('\n');
  }
  return { ...d, kind: next, items, body };
}

function sortEvents(list: CaptureEvent[]): CaptureEvent[] {
  return [...list].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}

type Phase = 'idle' | 'listening' | 'parsing' | 'review';

export function Capture() {
  const speech = useSpeechRecognition({
    lang: typeof navigator !== 'undefined' ? navigator.language : 'en-US',
  });

  const [projects, setProjects] = useState<Project[]>([]);
  const [llm, setLlm] = useState(false);

  const [phase, setPhase] = useState<Phase>('idle');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [typed, setTyped] = useState('');
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<{ msg: string; link?: string } | null>(null);

  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [events, setEvents] = useState<CaptureEvent[]>([]);

  // manual "New reminder" form
  const [mText, setMText] = useState('');
  const [mWhen, setMWhen] = useState('');
  const [mProject, setMProject] = useState<number | null>(null);
  const [mErr, setMErr] = useState<string | null>(null);
  const [mAdding, setMAdding] = useState(false);

  // ————— initial load —————
  useEffect(() => {
    let alive = true;
    (async () => {
      const [caps, projs, cls, rems, evs] = await Promise.all([
        getCapabilities().catch(() => ({ llm: false })),
        listProjects().catch(() => [] as Project[]),
        listChecklists().catch(() => [] as Checklist[]),
        listReminders().catch(() => [] as Reminder[]),
        listEvents().catch(() => [] as CaptureEvent[]),
      ]);
      if (!alive) return;
      setLlm(caps.llm);
      setProjects(projs);
      setChecklists(cls);
      setReminders(rems);
      setEvents(sortEvents(evs));
    })();
    return () => {
      alive = false;
    };
  }, []);

  // ————— parse when a spoken capture ends —————
  const { supported, listening, interim, finalTranscript, start, stop, reset } = speech;
  useEffect(() => {
    if (!listening && phase === 'listening') {
      const text = finalTranscript.trim();
      if (text) void runParse(text);
      else setPhase('idle');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listening]);

  async function runParse(text: string) {
    setPhase('parsing');
    setParseErr(null);
    setConfirm(null);
    try {
      const p = await parseTranscript(text);
      setDraft(draftFromParsed(p, text));
      setPhase('review');
    } catch {
      setParseErr('Could not read that capture — try again.');
      setPhase('idle');
    }
  }

  function onMicClick() {
    if (listening) {
      stop();
    } else {
      setConfirm(null);
      setParseErr(null);
      setPhase('listening');
      start();
    }
  }

  function onTypedSubmit() {
    const text = typed.trim();
    if (!text) return;
    setTyped('');
    void runParse(text);
  }

  function backToIdle() {
    setDraft(null);
    setPhase('idle');
    reset();
  }

  function onDiscard() {
    if (window.confirm('Discard this capture?')) backToIdle();
  }

  function finish(msg: string, link?: string) {
    backToIdle();
    setConfirm({ msg, link });
  }

  // ————— save the reviewed draft —————
  async function onSave() {
    if (!draft) return;
    setSaveErr(null);
    setSaving(true);
    try {
      if (draft.kind === 'checklist') {
        const items = draft.items
          .map((i) => i.text.trim())
          .filter(Boolean)
          .map((text) => ({ text }));
        if (items.length === 0) {
          setSaveErr('Add at least one item before saving.');
          return;
        }
        const cl = await createChecklist({
          title: draft.title.trim() || 'Checklist',
          project_id: draft.projectId,
          source_transcript: draft.transcript,
          items,
        });
        setChecklists((prev) => [cl, ...prev]);
        finish('Checklist saved.');
      } else if (draft.kind === 'note') {
        if (draft.projectId == null) {
          setSaveErr('Pick a project for this note.');
          return;
        }
        await createNoteFromCapture(draft.projectId, {
          title: draft.title.trim() || 'Note',
          body_md: draft.body,
          source_transcript: draft.transcript,
        });
        finish('Note saved.', `/projects/${draft.projectId}`);
      } else if (draft.kind === 'reminder') {
        const r = await createReminder({
          text: draft.title.trim() || 'Reminder',
          remind_at: draft.datetime || null,
          project_id: draft.projectId,
          source_transcript: draft.transcript,
        });
        setReminders((prev) => [r, ...prev]);
        finish('Reminder set.');
      } else {
        if (!draft.datetime) {
          setSaveErr('Pick a date and time for this event.');
          return;
        }
        const ev = await createEvent({
          title: draft.title.trim() || 'Event',
          starts_at: draft.datetime,
          project_id: draft.projectId,
          source_transcript: draft.transcript,
        });
        setEvents((prev) => sortEvents([ev, ...prev]));
        finish('Event saved.');
      }
    } catch (e) {
      setSaveErr(
        e instanceof ApiError && e.fields
          ? 'Please check the highlighted fields.'
          : 'Could not save — try again.',
      );
    } finally {
      setSaving(false);
    }
  }

  // ————— manual reminder form —————
  async function onAddManual(e: React.FormEvent) {
    e.preventDefault();
    if (!mText.trim()) return;
    setMErr(null);
    setMAdding(true);
    try {
      const r = await createReminder({
        text: mText.trim(),
        remind_at: mWhen || null,
        project_id: mProject,
      });
      setReminders((prev) => [r, ...prev]);
      setMText('');
      setMWhen('');
      setMProject(null);
    } catch {
      setMErr('Could not add that reminder — try again.');
    } finally {
      setMAdding(false);
    }
  }

  async function setReminderStatus(r: Reminder, status: 'done' | 'dismissed') {
    try {
      const up = await updateReminder(r.id, { status });
      setReminders((prev) => prev.map((x) => (x.id === r.id ? up : x)));
    } catch {
      /* leave the row as-is; the user can retry */
    }
  }

  async function removeReminder(r: Reminder) {
    try {
      await deleteReminder(r.id);
      setReminders((prev) => prev.filter((x) => x.id !== r.id));
    } catch {
      /* keep it visible on failure */
    }
  }

  async function removeChecklist(id: number) {
    try {
      await deleteChecklist(id);
      setChecklists((prev) => prev.filter((c) => c.id !== id));
    } catch {
      /* keep it */
    }
  }

  async function removeEvent(id: number) {
    try {
      await deleteEvent(id);
      setEvents((prev) => prev.filter((ev) => ev.id !== id));
    } catch {
      /* keep it */
    }
  }

  const projectName = useMemo(() => {
    const map = new Map<number, string>();
    for (const p of projects) map.set(p.id, p.name);
    return (id: number | null) => (id != null ? (map.get(id) ?? '') : '');
  }, [projects]);

  const visibleReminders = reminders.filter((r) => r.status !== 'dismissed');

  return (
    <div className="vc-page">
      <div className="vc-head">
        <h1>Capture</h1>
        <span>Speak it or type it — review, then save.</span>
      </div>

      <div className="vc-promo">
        <span className="k">Voice capture</span>
        <p>
          Speak it, check it, save it. Transcription happens in your browser — we only ever see the
          text, and nothing is saved until you confirm.
        </p>
      </div>

      {confirm && (
        <div className="vc-confirm">
          <span>{confirm.msg}</span>
          {confirm.link && <Link to={confirm.link}>Open</Link>}
        </div>
      )}

      {/* ————— capture area ————— */}
      {phase === 'review' && draft ? (
        <DraftCard
          draft={draft}
          projects={projects}
          saving={saving}
          error={saveErr}
          onChange={setDraft}
          onSave={onSave}
          onDiscard={onDiscard}
        />
      ) : supported ? (
        <div className="vc-capture">
          <button
            type="button"
            className={`vc-mic${listening ? ' rec' : ''}`}
            aria-label={listening ? 'Stop recording' : 'Start recording'}
            aria-pressed={listening}
            onClick={onMicClick}
            disabled={phase === 'parsing'}
          >
            <MicGlyph />
          </button>
          <span className="vc-listen">
            {listening ? 'Listening…' : phase === 'parsing' ? 'Reading…' : 'Tap to speak'}
          </span>
          <p className="vc-interim">{listening ? interim : ''}</p>
          {speech.error && <p className="vc-inline-err">{speech.error}</p>}
          {parseErr && <p className="vc-inline-err">{parseErr}</p>}
          <p className="vc-hint">
            Say <b>&ldquo;checklist&rdquo;</b>, <b>&ldquo;note&rdquo;</b>,{' '}
            <b>&ldquo;remind me&rdquo;</b>, or <b>&ldquo;event&rdquo;</b> — and{' '}
            <b>&ldquo;for &lt;project&gt;&rdquo;</b> to file it.
            {llm ? ' Structured with Claude.' : ''}
          </p>
        </div>
      ) : (
        <div className="vc-capture">
          <textarea
            className="vc-ta"
            placeholder="Type your capture — e.g. “checklist for Acme call the bank then send the invoice”"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          <button
            type="button"
            className="vc-btn primary"
            onClick={onTypedSubmit}
            disabled={!typed.trim() || phase === 'parsing'}
          >
            {phase === 'parsing' ? 'Reading…' : 'Review capture'}
          </button>
          {parseErr && <p className="vc-inline-err">{parseErr}</p>}
          <p className="vc-hint">
            This browser has no speech recognition, so capture is typed — the same triggers work:{' '}
            <b>checklist</b>, <b>note</b>, <b>remind me</b>, <b>event</b>, <b>for &lt;project&gt;</b>.
          </p>
        </div>
      )}

      {/* ————— reminders (manual form + list) ————— */}
      <section className="vc-rem">
        <div className="vc-rem-h">
          <h4>Reminders</h4>
          <span>Set one by hand — no mic needed.</span>
        </div>
        <form className="vc-rem-form" onSubmit={onAddManual}>
          <input
            type="text"
            placeholder="Remind me to…"
            value={mText}
            onChange={(e) => setMText(e.target.value)}
            aria-label="Reminder text"
          />
          <input
            type="datetime-local"
            value={mWhen}
            onChange={(e) => setMWhen(e.target.value)}
            aria-label="Remind at (optional)"
          />
          <select
            value={mProject ?? ''}
            onChange={(e) => setMProject(e.target.value ? Number(e.target.value) : null)}
            aria-label="Project (optional)"
          >
            <option value="">No project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button type="submit" className="vc-btn primary" disabled={!mText.trim() || mAdding}>
            Add
          </button>
        </form>
        {mErr && <p className="vc-inline-err">{mErr}</p>}

        {visibleReminders.length === 0 ? (
          <p className="vc-empty">No reminders yet.</p>
        ) : (
          <div className="vc-rlist">
            {visibleReminders.map((r) => (
              <div className={`vc-rrow${r.status === 'done' ? ' done' : ''}`} key={r.id}>
                <span className="rtext">
                  {r.text}
                  {r.project_id != null && projectName(r.project_id) ? (
                    <span className="vc-src"> · {projectName(r.project_id)}</span>
                  ) : null}
                </span>
                <span className={`rwhen${r.remind_at ? '' : ' undated'}`}>
                  {formatWhen(r.remind_at)}
                </span>
                <span className="vc-racts">
                  {r.status === 'pending' && (
                    <button
                      type="button"
                      className="vc-act"
                      onClick={() => setReminderStatus(r, 'done')}
                    >
                      Done
                    </button>
                  )}
                  <button type="button" className="vc-act" onClick={() => removeReminder(r)}>
                    Dismiss
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ————— recent captures ————— */}
      <div className="vc-recent">
        <section>
          <h4>Recent checklists</h4>
          {checklists.length === 0 ? (
            <p className="vc-empty">No checklists yet.</p>
          ) : (
            checklists.map((c) => (
              <div className="vc-saved" key={c.id}>
                <ChecklistView mode="saved" checklist={c} />
                <div className="vc-racts" style={{ marginTop: 8 }}>
                  {c.project_id != null && projectName(c.project_id) ? (
                    <span className="vc-src">{projectName(c.project_id)}</span>
                  ) : null}
                  <button type="button" className="vc-act" onClick={() => removeChecklist(c.id)}>
                    Delete
                  </button>
                </div>
              </div>
            ))
          )}
        </section>

        <section>
          <h4>Upcoming events</h4>
          {events.length === 0 ? (
            <p className="vc-empty">No events yet.</p>
          ) : (
            <div className="vc-elist">
              {events.map((ev) => (
                <div className="vc-erow" key={ev.id}>
                  <span className="etitle">{ev.title}</span>
                  <span className="ewhen">{formatWhen(ev.starts_at)}</span>
                  <button type="button" className="vc-act" onClick={() => removeEvent(ev.id)}>
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// ————— review draft card —————

function DraftCard({
  draft,
  projects,
  saving,
  error,
  onChange,
  onSave,
  onDiscard,
}: {
  draft: Draft;
  projects: Project[];
  saving: boolean;
  error: string | null;
  onChange: (d: Draft) => void;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const dated = draft.kind === 'reminder' || draft.kind === 'event';

  return (
    <div className="vc-draft">
      <div className="vc-draft-b">
        <div className="vc-kinds" role="group" aria-label="Capture kind">
          {(Object.keys(KIND_LABELS) as CaptureKind[]).map((k) => (
            <button
              key={k}
              type="button"
              className={`vc-kind${draft.kind === k ? ' on' : ''}`}
              onClick={() => onChange(changeKind(draft, k))}
            >
              {KIND_LABELS[k]}
            </button>
          ))}
        </div>

        <div className="vc-field">
          <label htmlFor="vc-title">{draft.kind === 'reminder' ? 'Reminder' : 'Title'}</label>
          <input
            id="vc-title"
            type="text"
            value={draft.title}
            onChange={(e) => set({ title: e.target.value })}
          />
        </div>

        {draft.kind === 'checklist' && (
          <ChecklistView
            mode="review"
            items={draft.items}
            onChange={(items) => set({ items })}
          />
        )}

        {draft.kind === 'note' && (
          <div className="vc-field">
            <label htmlFor="vc-body">Note</label>
            <textarea
              id="vc-body"
              value={draft.body}
              onChange={(e) => set({ body: e.target.value })}
            />
          </div>
        )}

        {dated && (
          <div className="vc-field">
            <label htmlFor="vc-when">Date &amp; time</label>
            <input
              id="vc-when"
              type="datetime-local"
              value={draft.datetime}
              onChange={(e) => set({ datetime: e.target.value })}
            />
          </div>
        )}

        {draft.dateSuggestion && !dated && (
          <div className="vc-sugg">
            <span>Looks like a reminder — a date was mentioned.</span>
            <button
              type="button"
              onClick={() => onChange({ ...changeKind(draft, 'reminder'), dateSuggestion: false })}
            >
              Make it a reminder
            </button>
          </div>
        )}

        <div className="vc-field">
          <label htmlFor="vc-project">
            {draft.kind === 'note' ? 'File under project (required)' : 'Project'}
          </label>
          <select
            id="vc-project"
            value={draft.projectId ?? ''}
            onChange={(e) => set({ projectId: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">{draft.kind === 'note' ? 'Pick a project…' : 'No project'}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        {draft.transcript && (
          <details className="vc-raw">
            <summary>Raw transcript</summary>
            <p>{draft.transcript}</p>
          </details>
        )}

        {error && <p className="vc-inline-err">{error}</p>}
      </div>

      <div className="vc-draft-foot">
        <span className="vc-src">via {draft.source === 'llm' ? 'Claude' : 'rules'}</span>
        <span className="vc-btns">
          <button type="button" className="vc-btn" onClick={onDiscard} disabled={saving}>
            Discard
          </button>
          <button type="button" className="vc-btn primary" onClick={onSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </span>
      </div>
    </div>
  );
}

function MicGlyph() {
  return (
    <svg
      width="30"
      height="30"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="21" />
      <line x1="8" y1="21" x2="16" y2="21" />
    </svg>
  );
}
