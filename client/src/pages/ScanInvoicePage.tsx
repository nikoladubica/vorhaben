// Invoice scanner (ticket 14, step 4). Max-tier feature: upload an invoice → one Sonnet call
// extracts it and proposes a matched or new project + income entry → the user reviews (every field
// editable) and approves. NOTHING is written until approval, and approval goes through the EXISTING
// project/entry endpoints — the scan endpoint itself only meters. Reached from the Projects header.
//
// States: not-available (self-host without a key → redirect away), locked (available but not Max →
// upgrade line), and the working scanner (upload → review card → approve).

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../api';
import type { CompensationModel, ProjectType, ProjectWithMetrics } from '../types';
import { createProject, listProjectTypes, listProjects } from '../api/projects';
import { createEntry } from '../api/entries';
import {
  ACCEPTED_TYPES,
  MAX_UPLOAD_BYTES,
  getInvoiceCapabilities,
  scanInvoice,
  type Proposal,
  type ScanResult,
  type ScanUsage,
} from '../api/invoices';
import './scan.css';

const COMPENSATION_MODELS: CompensationModel[] = [
  'hourly',
  'salary_monthly',
  'salary_biweekly',
  'salary_weekly',
  'fixed',
  'commission',
  'variable',
];

// A local, fully-editable copy of the proposal — the review card binds to this, never to the raw
// server response, so nothing is ever written unedited.
interface Draft {
  action: 'add_to_existing' | 'create_project';
  projectId: number | null;
  newName: string;
  newType: string;
  newModel: CompensationModel;
  amount: string;
  currency: string;
  date: string;
  note: string;
}

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

function draftFromProposal(p: Proposal): Draft {
  return {
    action: p.action,
    projectId: p.project_id,
    newName: p.new_project?.name ?? '',
    newType: p.new_project?.type ?? 'other',
    newModel: p.new_project?.compensation_model ?? 'variable',
    amount: p.entry.amount != null ? String(p.entry.amount) : '',
    currency: p.entry.currency ?? '',
    date: p.entry.date ?? todayString(),
    note: p.entry.note ?? '',
  };
}

// Map a server error code to one calm line (Swiss copy: confident, not apologetic).
function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.error) {
      case 'scan_cap_reached':
        return 'You have used all your scans this month. They reset at the start of next month, or add your own API key for unlimited scans.';
      case 'assistant_budget_exceeded':
        return 'The assistant is paused for this billing cycle. It resets next month, or add your own API key.';
      case 'unsupported_media_type':
        return 'That file type is not supported. Upload a PDF, PNG, or JPEG.';
      case 'payload_too_large':
        return 'That file is larger than 10 MB. Upload a smaller file.';
      case 'upgrade_required':
        return 'The invoice scanner is a Max-plan feature.';
      default:
        return 'Could not read that invoice. Try again, or file it manually.';
    }
  }
  return 'Could not read that invoice. Try again, or file it manually.';
}

export function ScanInvoicePage() {
  const navigate = useNavigate();

  const [ready, setReady] = useState(false);
  const [available, setAvailable] = useState(false);
  const [entitled, setEntitled] = useState(false);
  const [scans, setScans] = useState<ScanUsage | null>(null);

  const [projects, setProjects] = useState<ProjectWithMetrics[]>([]);
  const [types, setTypes] = useState<ProjectType[]>([]);

  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getInvoiceCapabilities()
      .then((c) => {
        setAvailable(c.available);
        setEntitled(c.entitled);
        setScans(c.scans);
      })
      .catch(() => {
        setAvailable(false);
        setEntitled(false);
      })
      .finally(() => setReady(true));
  }, []);

  useEffect(() => {
    if (!entitled) return;
    listProjects()
      .then(setProjects)
      .catch(() => setProjects([]));
    listProjectTypes()
      .then(setTypes)
      .catch(() => setTypes([]));
  }, [entitled]);

  const typeLabels = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of types) m.set(t.id, t.label);
    return m;
  }, [types]);

  async function onFile(file: File) {
    setError(null);
    setResult(null);
    setDraft(null);

    if (!(ACCEPTED_TYPES as readonly string[]).includes(file.type)) {
      setError('That file type is not supported. Upload a PDF, PNG, or JPEG.');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError('That file is larger than 10 MB. Upload a smaller file.');
      return;
    }

    setScanning(true);
    try {
      const res = await scanInvoice(file);
      setResult(res);
      setDraft(draftFromProposal(res.proposal));
      if (res.scans) setScans(res.scans);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setScanning(false);
    }
  }

  const canApprove =
    draft !== null &&
    draft.amount.trim() !== '' &&
    Number.isFinite(Number(draft.amount)) &&
    draft.date.trim() !== '' &&
    (draft.action === 'add_to_existing' ? draft.projectId !== null : draft.newName.trim() !== '');

  async function onApprove() {
    if (!draft || !canApprove) return;
    setSaving(true);
    setError(null);
    try {
      const amount = Number(draft.amount);
      const currency = draft.currency.trim().toUpperCase() || undefined;

      let projectId = draft.projectId;
      if (draft.action === 'create_project') {
        // Create the project through the EXISTING endpoint (all normalization/defaults apply).
        const created = await createProject({
          name: draft.newName.trim(),
          type: draft.newType,
          description: null,
          status: 'active',
          start_date: draft.date || todayString(),
          end_date: null,
          compensation_model: draft.newModel,
          rate_amount: null,
          // Seed the project's currency from the invoice so future entries default sensibly. Only a
          // valid 3-letter code is sent.
          rate_currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
          tags: [],
        });
        projectId = created.id;
      }
      if (projectId == null) {
        setError('Pick a project to add this to.');
        setSaving(false);
        return;
      }

      // The income entry stores the ORIGINAL amount + currency; the server converts for display via
      // fx_rates and never overwrites the original (§2.2).
      await createEntry(projectId, {
        date: draft.date,
        amount,
        currency,
        note: draft.note.trim() || null,
      });

      navigate(`/projects/${projectId}`);
    } catch (err) {
      setError(err instanceof ApiError ? 'Could not save. Please try again.' : 'Could not save.');
      setSaving(false);
    }
  }

  function reset() {
    setResult(null);
    setDraft(null);
    setError(null);
  }

  // ————— render —————

  if (!ready) {
    return (
      <div>
        <div className="dash-head">
          <h3>Scan invoice</h3>
        </div>
        <p className="table-empty">Loading…</p>
      </div>
    );
  }

  // Self-host with no platform key and no BYOK → the feature is not offered. Send them back.
  if (!available) {
    return (
      <div>
        <div className="dash-head">
          <h3>Scan invoice</h3>
        </div>
        <div className="panel">
          <div className="panel-b">
            <p>
              The invoice scanner needs an assistant key. Add your own Anthropic API key in{' '}
              <Link to="/settings" className="project-link">
                Settings → Assistant
              </Link>{' '}
              to turn it on.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="dash-head">
        <h3>Scan invoice</h3>
        {scans && (
          <span className="s num">
            {scans.used} of {scans.cap} scans this month
          </span>
        )}
      </div>

      {!entitled ? (
        // Available but not Max — a locked state with ONE upgrade line (never a hidden feature).
        <div className="panel scan-locked">
          <div className="panel-b">
            <p className="scan-lock-line">
              The invoice scanner reads a PDF or photo of an invoice and drafts the income entry for
              you — matched to the right project. It is part of the <strong>Max</strong> plan.
            </p>
            <Link className="btn primary sm" to="/settings">
              Upgrade to Max
            </Link>
          </div>
        </div>
      ) : (
        <>
          <p className="scan-intro">
            Upload an invoice you issued (PDF, PNG, or JPEG). The assistant reads it and proposes an
            income entry — you review and approve before anything is saved.
          </p>

          {!result && (
            <div className="panel">
              <div className="panel-b scan-drop">
                <label className="btn primary" aria-disabled={scanning}>
                  {scanning ? 'Reading invoice…' : 'Choose invoice file'}
                  <input
                    type="file"
                    accept={ACCEPTED_TYPES.join(',')}
                    disabled={scanning}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void onFile(f);
                      e.target.value = '';
                    }}
                    hidden
                  />
                </label>
                <span className="scan-hint">
                  PDF, PNG or JPEG · up to 10 MB · nothing is stored
                </span>
              </div>
            </div>
          )}

          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}

          {result && draft && (
            <div className="panel scan-review">
              <div className="panel-h">
                <span className="t">Review</span>
                <span className="s">
                  {result.proposal.confidence === 'low'
                    ? 'Low confidence — check the project'
                    : result.proposal.reasoning || 'Extracted from your invoice'}
                </span>
              </div>
              <div className="panel-b scan-form">
                {/* What extracted from the invoice, all editable */}
                <div className="scan-grid">
                  <label className="scan-field">
                    <span className="scan-label">Amount</span>
                    <input
                      className="scan-input num"
                      inputMode="decimal"
                      value={draft.amount}
                      onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
                    />
                  </label>
                  <label className="scan-field">
                    <span className="scan-label">Currency</span>
                    <input
                      className="scan-input"
                      maxLength={3}
                      value={draft.currency}
                      onChange={(e) =>
                        setDraft({ ...draft, currency: e.target.value.toUpperCase() })
                      }
                    />
                  </label>
                  <label className="scan-field">
                    <span className="scan-label">Date</span>
                    <input
                      className="scan-input"
                      type="date"
                      value={draft.date}
                      onChange={(e) => setDraft({ ...draft, date: e.target.value })}
                    />
                  </label>
                  <label className="scan-field scan-field-wide">
                    <span className="scan-label">Note</span>
                    <input
                      className="scan-input"
                      value={draft.note}
                      onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                    />
                  </label>
                </div>

                {/* Where it goes: add to an existing project or create a new one */}
                <div className="scan-dest">
                  <div className="scan-dest-toggle">
                    <label>
                      <input
                        type="radio"
                        name="action"
                        checked={draft.action === 'add_to_existing'}
                        onChange={() => setDraft({ ...draft, action: 'add_to_existing' })}
                      />
                      Add to an existing project
                    </label>
                    <label>
                      <input
                        type="radio"
                        name="action"
                        checked={draft.action === 'create_project'}
                        onChange={() => setDraft({ ...draft, action: 'create_project' })}
                      />
                      Create a new project
                    </label>
                  </div>

                  {draft.action === 'add_to_existing' ? (
                    <label className="scan-field scan-field-wide">
                      <span className="scan-label">Project</span>
                      <select
                        className="scan-input"
                        value={draft.projectId ?? ''}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            projectId: e.target.value ? Number(e.target.value) : null,
                          })
                        }
                      >
                        <option value="">Select a project…</option>
                        {projects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <div className="scan-grid">
                      <label className="scan-field scan-field-wide">
                        <span className="scan-label">New project name</span>
                        <input
                          className="scan-input"
                          value={draft.newName}
                          onChange={(e) => setDraft({ ...draft, newName: e.target.value })}
                        />
                      </label>
                      <label className="scan-field">
                        <span className="scan-label">Type</span>
                        <select
                          className="scan-input"
                          value={draft.newType}
                          onChange={(e) => setDraft({ ...draft, newType: e.target.value })}
                        >
                          {types.map((t) => (
                            <option key={t.id} value={t.id}>
                              {typeLabels.get(t.id) ?? t.id}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="scan-field">
                        <span className="scan-label">Compensation</span>
                        <select
                          className="scan-input"
                          value={draft.newModel}
                          onChange={(e) =>
                            setDraft({ ...draft, newModel: e.target.value as CompensationModel })
                          }
                        >
                          {COMPENSATION_MODELS.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  )}
                </div>

                <div className="scan-actions">
                  <button
                    type="button"
                    className="btn primary sm"
                    disabled={!canApprove || saving}
                    onClick={() => void onApprove()}
                  >
                    {saving
                      ? 'Saving…'
                      : draft.action === 'create_project'
                        ? 'Create project & add income'
                        : 'Add income'}
                  </button>
                  <button type="button" className="btn ghost sm" disabled={saving} onClick={reset}>
                    Discard
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
