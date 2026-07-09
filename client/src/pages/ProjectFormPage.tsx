import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../api';
import type { CompensationModel, ProjectPayload, ProjectStatus, ProjectType } from '../types';
import {
  createProject,
  getProject,
  listProjectTypes,
  softDeleteProject,
  updateProject,
} from '../api/projects';
import { COMPENSATION_CONFIG, COMPENSATION_MODELS, modelHasAmount } from '../domain/compensation';
import { TagInput } from '../components/projects/TagInput';
import { CURRENCIES } from '../domain/currencies';

// The status intent the user can set. `ended` is never offered — it is derived by the server
// from a past end date (§1.3).
type StatusChoice = 'active' | 'paused' | 'idea';

const STATUS_CHOICES: { value: StatusChoice; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'idea', label: 'Idea' },
];

// Editable form state — every value is a string (or string[]), converted to the API shape
// only when building the payload (amounts stay strings in state, ticket 04).
interface FormState {
  name: string;
  type: string;
  description: string;
  start_date: string;
  end_date: string;
  status: StatusChoice;
  compensation_model: CompensationModel;
  rate_amount: string;
  rate_currency: string;
  tags: string[];
}

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyForm(): FormState {
  return {
    name: '',
    type: '',
    description: '',
    start_date: todayString(),
    end_date: '',
    status: 'active',
    compensation_model: 'hourly',
    rate_amount: '',
    rate_currency: 'CHF',
    tags: [],
  };
}

// Translate a server/client field-error code into human copy. Codes align with
// server/src/routes/projects.ts.
function fieldMessage(field: string, code: string): string {
  switch (code) {
    case 'required':
      return 'This field is required.';
    case 'too_long':
      return 'This is too long.';
    case 'unknown':
      return 'Please choose a valid option.';
    case 'before_start':
      return 'End date must be on or after the start date.';
    case 'invalid':
    default:
      return field === 'rate_amount' ? 'Enter a valid amount.' : 'This value is not valid.';
  }
}

export function ProjectFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isEdit = id !== undefined;
  const projectId = id ? Number(id) : null;

  const [form, setForm] = useState<FormState>(emptyForm);
  const [types, setTypes] = useState<ProjectType[]>([]);
  const [loading, setLoading] = useState(isEdit);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // Field errors are stored as codes and translated at render time.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    listProjectTypes()
      .then(setTypes)
      .catch(() => setTypes([]));
  }, []);

  useEffect(() => {
    if (!isEdit || projectId === null) return;
    let cancelled = false;
    setLoading(true);
    getProject(projectId)
      .then((project) => {
        if (cancelled) return;
        setForm({
          name: project.name,
          type: project.type,
          description: project.description ?? '',
          start_date: project.start_date,
          end_date: project.end_date ?? '',
          // `ended` is derived from the end date — surface the underlying intent as Active.
          status: project.status === 'ended' ? 'active' : project.status,
          compensation_model: project.compensation_model,
          rate_amount: project.rate_amount ?? '',
          rate_currency: project.rate_currency ?? 'CHF',
          tags: project.tags,
        });
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not load this project.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isEdit, projectId]);

  const modelConfig = COMPENSATION_CONFIG[form.compensation_model];
  const showAmount = modelHasAmount(form.compensation_model);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  // Client-side checks that mirror the server; returns codes keyed by field.
  function clientValidate(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (form.name.trim().length < 1) errors.name = 'required';
    if (form.type.trim().length < 1) errors.type = 'required';
    if (form.start_date.trim().length < 1) errors.start_date = 'required';
    if (form.start_date && form.end_date && form.end_date < form.start_date) {
      errors.end_date = 'before_start';
    }
    return errors;
  }

  function buildPayload(): ProjectPayload {
    const amount = showAmount && form.rate_amount.trim() !== '' ? Number(form.rate_amount) : null;
    return {
      name: form.name.trim(),
      type: form.type,
      description: form.description.trim() === '' ? null : form.description,
      status: form.status as ProjectStatus,
      start_date: form.start_date,
      end_date: form.end_date === '' ? null : form.end_date,
      compensation_model: form.compensation_model,
      rate_amount: amount,
      rate_currency: form.rate_currency,
      tags: form.tags,
    };
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const clientErrors = clientValidate();
    if (Object.keys(clientErrors).length > 0) {
      setFieldErrors(clientErrors);
      return;
    }
    setFieldErrors({});
    setPending(true);
    try {
      if (isEdit && projectId !== null) {
        await updateProject(projectId, buildPayload());
      } else {
        await createProject(buildPayload());
      }
      navigate('/projects');
    } catch (err) {
      if (err instanceof ApiError && err.fields) {
        setFieldErrors(err.fields);
      } else {
        setFormError('Could not save the project. Please try again.');
      }
    } finally {
      setPending(false);
    }
  }

  async function onConfirmDelete() {
    if (projectId === null) return;
    setPending(true);
    try {
      await softDeleteProject(projectId);
      navigate('/projects', {
        state: { trashed: { id: projectId, name: form.name } },
      });
    } catch {
      setFormError('Could not move the project to trash. Please try again.');
      setPending(false);
    }
  }

  const heading = isEdit ? 'Edit project' : 'New project';

  const currencyPrefix = useMemo(() => form.rate_currency || 'CHF', [form.rate_currency]);

  if (loading) {
    return (
      <div>
        <p className="crumb num">
          <Link to="/projects">Projects</Link> / {heading}
        </p>
        <p className="table-empty">Loading…</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div>
        <p className="crumb num">
          <Link to="/projects">Projects</Link> / {heading}
        </p>
        <p className="form-error" role="alert">
          {loadError}
        </p>
      </div>
    );
  }

  return (
    <div className="form-page">
      <p className="crumb num">
        <Link to="/projects">Projects</Link> / {heading}
      </p>
      <div className="dash-head">
        <h3>{heading}</h3>
      </div>

      <form onSubmit={onSubmit} noValidate>
        {formError && (
          <p className="form-error" role="alert">
            {formError}
          </p>
        )}

        <div className="fgrid">
          <label className="field full">
            <span>Name</span>
            <input
              type="text"
              value={form.name}
              onChange={(e) => update('name', e.target.value)}
              aria-invalid={fieldErrors.name ? true : undefined}
            />
            {fieldErrors.name && (
              <em className="field-error">{fieldMessage('name', fieldErrors.name)}</em>
            )}
          </label>

          <label className="field">
            <span>Type</span>
            <select
              value={form.type}
              onChange={(e) => update('type', e.target.value)}
              aria-invalid={fieldErrors.type ? true : undefined}
            >
              <option value="">Select a type…</option>
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
            {fieldErrors.type && (
              <em className="field-error">{fieldMessage('type', fieldErrors.type)}</em>
            )}
          </label>

          <div className="field">
            <span id="status-label">Status</span>
            <div className="seg" role="radiogroup" aria-labelledby="status-label">
              {STATUS_CHOICES.map((s) => (
                <span className="sopt" key={s.value}>
                  <input
                    type="radio"
                    name="status"
                    id={`status-${s.value}`}
                    checked={form.status === s.value}
                    onChange={() => update('status', s.value)}
                  />
                  <label htmlFor={`status-${s.value}`}>{s.label}</label>
                </span>
              ))}
            </div>
            <em className="field-hint">Projects end automatically when their end date passes.</em>
          </div>

          <label className="field">
            <span>Started</span>
            <input
              type="date"
              value={form.start_date}
              onChange={(e) => update('start_date', e.target.value)}
              aria-invalid={fieldErrors.start_date ? true : undefined}
            />
            {fieldErrors.start_date && (
              <em className="field-error">{fieldMessage('start_date', fieldErrors.start_date)}</em>
            )}
          </label>

          <label className="field">
            <span>Ended — optional</span>
            <input
              type="date"
              value={form.end_date}
              onChange={(e) => update('end_date', e.target.value)}
              aria-invalid={fieldErrors.end_date ? true : undefined}
            />
            {fieldErrors.end_date && (
              <em className="field-error">{fieldMessage('end_date', fieldErrors.end_date)}</em>
            )}
          </label>

          <div className="field full">
            <span id="model-label">How are you paid?</span>
            <div className="seg" role="radiogroup" aria-labelledby="model-label">
              {COMPENSATION_MODELS.map((m) => (
                <span className="sopt" key={m}>
                  <input
                    type="radio"
                    name="compensation_model"
                    id={`model-${m}`}
                    checked={form.compensation_model === m}
                    onChange={() => update('compensation_model', m)}
                  />
                  <label htmlFor={`model-${m}`}>{COMPENSATION_CONFIG[m].label}</label>
                </span>
              ))}
            </div>
            {fieldErrors.compensation_model && (
              <em className="field-error">
                {fieldMessage('compensation_model', fieldErrors.compensation_model)}
              </em>
            )}
          </div>

          {showAmount ? (
            <label className="field">
              <span>{modelConfig.amountLabel}</span>
              <span className="aff">
                <b>{currencyPrefix}</b>
                <input
                  type="text"
                  inputMode="decimal"
                  value={form.rate_amount}
                  placeholder={modelConfig.amountPlaceholder}
                  onChange={(e) => update('rate_amount', e.target.value)}
                  aria-label={modelConfig.amountLabel}
                  aria-invalid={fieldErrors.rate_amount ? true : undefined}
                />
              </span>
              {fieldErrors.rate_amount && (
                <em className="field-error">
                  {fieldMessage('rate_amount', fieldErrors.rate_amount)}
                </em>
              )}
            </label>
          ) : (
            <p className="field full comp-hint">{modelConfig.hint}</p>
          )}

          <label className="field">
            <span>Currency</span>
            <select
              value={form.rate_currency}
              onChange={(e) => update('rate_currency', e.target.value)}
              aria-invalid={fieldErrors.rate_currency ? true : undefined}
            >
              {CURRENCIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            {fieldErrors.rate_currency && (
              <em className="field-error">
                {fieldMessage('rate_currency', fieldErrors.rate_currency)}
              </em>
            )}
          </label>

          <label className="field full">
            <span>Description — optional</span>
            <textarea
              rows={3}
              value={form.description}
              placeholder="What is this work, in one line?"
              onChange={(e) => update('description', e.target.value)}
            />
          </label>

          <div className="field full">
            <span id="tags-label">Tags</span>
            <TagInput
              id="tags-input"
              value={form.tags}
              onChange={(tags) => update('tags', tags)}
              invalid={Boolean(fieldErrors.tags)}
            />
            {fieldErrors.tags && (
              <em className="field-error">{fieldMessage('tags', fieldErrors.tags)}</em>
            )}
          </div>
        </div>

        <div className="form-actions">
          <Link className="btn ghost" to="/projects">
            Cancel
          </Link>
          <button className="btn primary" type="submit" disabled={pending}>
            {pending ? 'Saving…' : isEdit ? 'Save changes' : 'Create project'}
          </button>
        </div>
      </form>

      {isEdit && (
        <div className="danger-zone">
          {confirmingDelete ? (
            <div className="delete-confirm">
              <p>
                This moves <strong>{form.name || 'this project'}</strong> to trash. You can restore
                it from the projects list.
              </p>
              <div className="delete-confirm-actions">
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => setConfirmingDelete(false)}
                  disabled={pending}
                >
                  Keep project
                </button>
                <button
                  type="button"
                  className="btn ghost sm danger"
                  onClick={onConfirmDelete}
                  disabled={pending}
                >
                  Move to trash
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => setConfirmingDelete(true)}
            >
              Move to trash
            </button>
          )}
        </div>
      )}
    </div>
  );
}
