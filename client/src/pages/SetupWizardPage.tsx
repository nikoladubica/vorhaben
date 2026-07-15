// The onboarding wizard (design screen "03 — Onboarding"), reached from the Honesty Contract's
// "Continue" for a fresh, zero-project account. Four calm steps that turn the user's own answers
// into real projects — nothing connects to a bank or wallet, and everything here is editable later.
//
//   1. Income types  — multi-select the kinds of work that bring money in
//   2. Details       — one draft project at a time, walked through a queue built from step 1;
//                      an optional "add another of the same type" prompt lets a user register
//                      several contracts / gigs / products without leaving the step
//   3. Time & currency — base currency + the track-hours vs revenue-only decision
//   4. Review        — each draft shown with its monthly-equivalent (§2.2) and a running total,
//                      then "Create projects" persists the account settings and every draft.
//
// Presentational + type-first: money math lives in the pure `monthlyEquivalent` helper below,
// mirroring BUSINESS_LOGIC §2.2; the component only shapes state and calls the API layer.

import { useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/useAuth';
import { updateAccount } from '../api/account';
import { createProject, listProjectTypes } from '../api/projects';
import { armCanvasHint, isOnboarded, markOnboarded } from '../onboarding';
import { ApiError } from '../api';
import type { CompensationModel, ProjectType } from '../types';
import './wizard.css';

const TOTAL_STEPS = 4;

// Short, user-side descriptions per income type (the API gives the canonical label; this adds the
// one-line "what is it"). Keyed by the type ids from GET /api/project-types.
const TYPE_BLURB: Record<string, string> = {
  job: 'Salaried employment, full or part time',
  freelance_client: 'An ongoing client relationship',
  freelance_gig: 'A one-off engagement',
  contract: 'Fixed-term contract work',
  project: 'Side project or startup effort',
  commission: 'Referral, sales or commissioned work',
  margin: 'Buying and reselling at a markup',
  loan_interest: 'Interest on money you lent out',
  stock: 'Realised trading gains',
  dividend: 'Payouts from holdings',
  product: 'Something you sell — SaaS, e-book, goods',
  other: 'Crypto sales, royalties, windfalls',
};

// The 7 compensation models, in the design's segmented-control order, with friendly labels.
const COMP_OPTIONS: { id: CompensationModel; label: string }[] = [
  { id: 'salary_monthly', label: 'Monthly salary' },
  { id: 'salary_biweekly', label: 'Bi-weekly' },
  { id: 'salary_weekly', label: 'Weekly' },
  { id: 'hourly', label: 'Hourly' },
  { id: 'fixed', label: 'Fixed one-time' },
  { id: 'commission', label: 'Commission' },
  { id: 'variable', label: 'Variable' },
];
const COMP_LABEL: Record<CompensationModel, string> = Object.fromEntries(
  COMP_OPTIONS.map((o) => [o.id, o.label]),
) as Record<CompensationModel, string>;

// A sensible default compensation model per income type — a starting point the user can change.
const DEFAULT_COMP: Record<string, CompensationModel> = {
  job: 'salary_monthly',
  freelance_client: 'hourly',
  freelance_gig: 'fixed',
  contract: 'fixed',
  product: 'variable',
  project: 'variable',
  commission: 'commission',
  margin: 'variable',
  loan_interest: 'variable',
  stock: 'variable',
  dividend: 'variable',
  other: 'variable',
};

// Base-currency choices (design step 3). The user's current base is guaranteed present below.
const CURRENCIES: { code: string; label: string }[] = [
  { code: 'CHF', label: 'CHF — Swiss franc' },
  { code: 'EUR', label: 'EUR — Euro' },
  { code: 'USD', label: 'USD — US dollar' },
  { code: 'GBP', label: 'GBP — Pound sterling' },
];

// Models whose amount is a required, meaningful figure vs. those driven by recorded entries.
const AMOUNT_REQUIRED: ReadonlySet<CompensationModel> = new Set<CompensationModel>([
  'salary_monthly',
  'salary_biweekly',
  'salary_weekly',
  'hourly',
  'fixed',
]);

// A draft project being assembled in step 2. `amount` stays a string in form state (parsed only at
// the boundary); a fresh, unique `id` gives React a stable key across queue insertions.
interface Draft {
  id: string;
  type: string;
  typeLabel: string;
  name: string;
  compensation_model: CompensationModel;
  amount: string;
  start_date: string;
  description: string;
}

let draftSeq = 0;
function makeDraft(type: ProjectType): Draft {
  draftSeq += 1;
  return {
    id: `d${draftSeq}`,
    type: type.id,
    typeLabel: type.label,
    name: '',
    compensation_model: DEFAULT_COMP[type.id] ?? 'variable',
    amount: '',
    start_date: today(),
    description: '',
  };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// Parse a user-typed amount ("4'200", "4200.50", "62") into a number, tolerating Swiss apostrophe
// and whitespace separators. Returns null when there is no usable positive number.
function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/['\s]/g, '').replace(',', '.');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Monthly-equivalent revenue for a draft, mirroring BUSINESS_LOGIC §2.2:
 *   salary_monthly  → amount as-is
 *   salary_biweekly → amount × 26 ÷ 12
 *   salary_weekly   → amount × 52 ÷ 12
 * hourly / fixed / commission / variable have no standalone monthly figure at onboarding time
 * (they need logged hours or recorded entries), so they return null — the review shows their rate
 * or "from entries" instead of inventing a number.
 */
function monthlyEquivalent(model: CompensationModel, amount: number | null): number | null {
  if (amount === null) return null;
  switch (model) {
    case 'salary_monthly':
      return amount;
    case 'salary_biweekly':
      return (amount * 26) / 12;
    case 'salary_weekly':
      return (amount * 52) / 12;
    default:
      return null;
  }
}

// Swiss apostrophe thousands (CHF 7'120). Rounded to a whole unit for headline figures.
function fmt(n: number): string {
  return Math.round(n).toLocaleString('de-CH');
}

// "2023-02-01" → "Feb 2023" for the review meta line.
function monthYear(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

// The label above the amount field, adapted to the chosen model.
function amountLabel(model: CompensationModel): string {
  switch (model) {
    case 'salary_monthly':
      return 'Amount per month';
    case 'salary_biweekly':
      return 'Amount per 2 weeks';
    case 'salary_weekly':
      return 'Amount per week';
    case 'hourly':
      return 'Rate per hour';
    case 'fixed':
      return 'Fixed amount';
    default:
      return 'Amount';
  }
}

// Is a draft complete enough to advance / create?
function draftComplete(d: Draft): boolean {
  if (d.name.trim() === '') return false;
  if (d.start_date === '') return false;
  if (AMOUNT_REQUIRED.has(d.compensation_model)) return parseAmount(d.amount) !== null;
  return true;
}

export function SetupWizardPage() {
  const auth = useAuth();
  const navigate = useNavigate();

  const [types, setTypes] = useState<ProjectType[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [step, setStep] = useState(1);
  const [current, setCurrent] = useState(0); // index into `drafts` while on step 2
  const [baseCurrency, setBaseCurrency] = useState('CHF');
  const [trackHours, setTrackHours] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the base currency from the signed-in user once known.
  useEffect(() => {
    if (auth.status === 'user') setBaseCurrency(auth.user.base_currency);
  }, [auth]);

  // Load the 12 income types once.
  useEffect(() => {
    let cancelled = false;
    listProjectTypes()
      .then((rows) => {
        if (!cancelled) setTypes(rows);
      })
      .catch(() => {
        if (!cancelled) setTypes([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Currency options, guaranteeing the user's current base is selectable even if it's off-list.
  const currencyOptions = useMemo(() => {
    if (CURRENCIES.some((c) => c.code === baseCurrency)) return CURRENCIES;
    return [{ code: baseCurrency, label: baseCurrency }, ...CURRENCIES];
  }, [baseCurrency]);

  // RequireAuth guarantees a user; this satisfies narrowing. An already-onboarded user who lands
  // here by URL is bounced home (mirrors OnboardingPage).
  if (auth.status !== 'user') return null;
  const user = auth.user;
  const userId = user.id;
  if (isOnboarded(userId)) return <Navigate to="/" replace />;

  if (types === null) {
    return <div className="app-boot" aria-hidden="true" />;
  }

  const typeList = types;
  const currentDraft: Draft | undefined = drafts[current];

  function toggleType(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function patchDraft(patch: Partial<Draft>) {
    setDrafts((prev) => prev.map((d, i) => (i === current ? { ...d, ...patch } : d)));
  }

  // Rebuild the step-2 queue from the current selection, PRESERVING drafts for types still selected
  // (including any "add another" duplicates) and dropping drafts whose type was deselected. Order
  // follows the type list; within a type, existing drafts keep their order.
  function reconcileQueue(): Draft[] {
    const byType = new Map<string, Draft[]>();
    for (const d of drafts) {
      const list = byType.get(d.type) ?? [];
      list.push(d);
      byType.set(d.type, list);
    }
    const next: Draft[] = [];
    for (const t of typeList) {
      if (!selected.has(t.id)) continue;
      const existing = byType.get(t.id);
      if (existing && existing.length > 0) next.push(...existing);
      else next.push(makeDraft(t));
    }
    return next;
  }

  function goBack() {
    setError(null);
    if (step === 2) {
      if (current > 0) setCurrent(current - 1);
      else setStep(1);
      return;
    }
    if (step === 3) {
      setStep(2);
      setCurrent(Math.max(0, drafts.length - 1));
      return;
    }
    if (step === 4) {
      setStep(3);
    }
  }

  function goNext() {
    setError(null);
    if (step === 1) {
      const queue = reconcileQueue();
      setDrafts(queue);
      setCurrent(0);
      setStep(2);
      return;
    }
    if (step === 2) {
      if (!currentDraft || !draftComplete(currentDraft)) return;
      if (current < drafts.length - 1) setCurrent(current + 1);
      else setStep(3);
      return;
    }
    if (step === 3) {
      setStep(4);
      return;
    }
    if (step === 4) {
      void finish();
    }
  }

  // Insert a fresh blank draft of the SAME type right after the current one, and move to it. Only
  // offered once the current draft is complete, so the user never loses in-progress input.
  function addAnother() {
    if (!currentDraft || !draftComplete(currentDraft)) return;
    const type = typeList.find((t) => t.id === currentDraft.type);
    if (!type) return;
    const fresh = makeDraft(type);
    setDrafts((prev) => {
      const next = [...prev];
      next.splice(current + 1, 0, fresh);
      return next;
    });
    setCurrent(current + 1);
    setError(null);
  }

  async function finish() {
    if (drafts.length === 0 || !drafts.every(draftComplete)) return;
    setSubmitting(true);
    setError(null);
    try {
      // 1. Persist account settings first (cheap, and reflects in the review currency).
      const updated = await updateAccount({ base_currency: baseCurrency, track_hours: trackHours });
      auth.updateUser({ ...user, ...updated });

      // 2. Create each drafted project. Stop on the first failure so the user can retry without
      //    duplicating the ones that already succeeded (they'd be dropped from the queue).
      for (let i = 0; i < drafts.length; i += 1) {
        const d = drafts[i];
        const amount = parseAmount(d.amount);
        try {
          await createProject({
            name: d.name.trim(),
            type: d.type,
            description: d.description.trim() || null,
            status: 'active',
            start_date: d.start_date,
            end_date: null,
            compensation_model: d.compensation_model,
            rate_amount: amount,
            rate_currency: baseCurrency,
            tags: [],
          });
        } catch (err) {
          const reason = err instanceof ApiError ? err.error : 'unknown error';
          setError(`Couldn't create “${d.name.trim() || d.typeLabel}” (${reason}). Nothing else was changed — fix it and try again.`);
          // Drop the successfully-created drafts so a retry doesn't duplicate them.
          setDrafts((prev) => prev.slice(i));
          setCurrent(0);
          setSubmitting(false);
          return;
        }
      }

      // 3. Only on full success: mark onboarded, arm the canvas mood hint, and enter the app.
      markOnboarded(userId);
      armCanvasHint(userId);
      navigate('/', { replace: true });
    } catch (err) {
      const reason = err instanceof ApiError ? err.error : 'unknown error';
      setError(`Couldn't save your settings (${reason}). Nothing was changed — try again.`);
      setSubmitting(false);
    }
  }

  // Footer state per step.
  const canAdvance =
    step === 1
      ? selected.size > 0
      : step === 2
        ? !!currentDraft && draftComplete(currentDraft)
        : step === 4
          ? drafts.length > 0 && drafts.every(draftComplete) && !submitting
          : true;

  const hint =
    step === 1
      ? `${selected.size} selected`
      : step === 2
        ? `Project ${current + 1} of ${drafts.length} — you can add more later`
        : step === 3
          ? 'Estimates are fine — precision comes later'
          : 'You can edit all of this from the dashboard';

  const nextLabel = step === TOTAL_STEPS ? (submitting ? 'Creating…' : 'Create projects') : 'Continue';

  const RAIL_STEPS = ['Income types', 'Details', 'Time & currency', 'Review'];

  return (
    <main className="wizard-stage">
      <section className="wizard" aria-label="Set up your projects">
        <div className="wiz-rail">
          <span className="wordmark">
            <span className="sq" aria-hidden="true"></span>VORHABEN
          </span>
          <span className="rail-step-mobile">
            Step {step} of {TOTAL_STEPS}
          </span>
          <div className="wiz-steps" aria-label="Onboarding steps">
            {RAIL_STEPS.map((label, i) => {
              const n = i + 1;
              const cls = n === step ? 'wstep on' : n < step ? 'wstep done' : 'wstep';
              return (
                <div className={cls} key={label} aria-current={n === step ? 'step' : undefined}>
                  <span className="wn num">{n}</span>
                  <span>{label}</span>
                </div>
              );
            })}
          </div>
          <p className="rail-foot">
            Nothing here connects to a bank or wallet. Every figure is yours to enter — and edit
            later.
          </p>
        </div>

        <div className="wiz-main">
          <div className="wiz-progress">
            <i style={{ width: `${(step / TOTAL_STEPS) * 100}%` }} />
          </div>

          {/* Step 1 — income types */}
          {step === 1 && (
            <div className="wiz-body">
              <span className="stepno num">Step 1 of 4</span>
              <h3>What brings money in?</h3>
              <p className="lead">
                Select everything that applies. Each one becomes a project you can track — you can
                always add more later.
              </p>
              <div className="type-grid">
                {typeList.map((t) => (
                  <span className="type-tile" key={t.id}>
                    <input
                      type="checkbox"
                      id={`tt-${t.id}`}
                      checked={selected.has(t.id)}
                      onChange={() => toggleType(t.id)}
                    />
                    <label htmlFor={`tt-${t.id}`}>
                      <span className="tick" aria-hidden="true"></span>
                      <h5>{t.label}</h5>
                      <p>{TYPE_BLURB[t.id] ?? ''}</p>
                    </label>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Step 2 — details, one draft at a time */}
          {step === 2 && currentDraft && (
            <div className="wiz-body">
              <span className="stepno num">Step 2 of 4</span>
              <h3>{currentDraft.typeLabel}</h3>
              <p className="lead">
                One at a time — the same few questions for each income you picked. You can go back
                and edit any of these later.
              </p>

              <div className="queue">
                {drafts.map((d, i) => {
                  const cls =
                    i === current ? 'qchip on' : i < current ? 'qchip done' : 'qchip';
                  return (
                    <span className={cls} key={d.id}>
                      {d.name.trim() || d.typeLabel}
                    </span>
                  );
                })}
              </div>

              <div className="fgrid">
                <label className="field full">
                  <span>Name</span>
                  <input
                    type="text"
                    value={currentDraft.name}
                    onChange={(e) => patchDraft({ name: e.target.value })}
                    placeholder="e.g. Acme Corp"
                  />
                </label>

                <div className="field full">
                  <span id={`comp-label-${currentDraft.id}`}>How are you paid?</span>
                  <div
                    className="seg"
                    role="radiogroup"
                    aria-labelledby={`comp-label-${currentDraft.id}`}
                  >
                    {COMP_OPTIONS.map((opt) => {
                      const id = `comp-${currentDraft.id}-${opt.id}`;
                      return (
                        <span className="sopt" key={opt.id}>
                          <input
                            type="radio"
                            name={`comp-${currentDraft.id}`}
                            id={id}
                            checked={currentDraft.compensation_model === opt.id}
                            onChange={() => patchDraft({ compensation_model: opt.id })}
                          />
                          <label htmlFor={id}>{opt.label}</label>
                        </span>
                      );
                    })}
                  </div>
                </div>

                {AMOUNT_REQUIRED.has(currentDraft.compensation_model) && (
                  <label className="field">
                    <span>{amountLabel(currentDraft.compensation_model)}</span>
                    <span className="aff">
                      <b>{baseCurrency}</b>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={currentDraft.amount}
                        onChange={(e) => patchDraft({ amount: e.target.value })}
                        placeholder="0"
                        aria-label={`${amountLabel(currentDraft.compensation_model)} in ${baseCurrency}`}
                      />
                    </span>
                  </label>
                )}

                <label className="field">
                  <span>Started</span>
                  <input
                    type="date"
                    value={currentDraft.start_date}
                    max={today()}
                    onChange={(e) => patchDraft({ start_date: e.target.value })}
                  />
                </label>

                <label className="field full">
                  <span>Description — optional</span>
                  <input
                    type="text"
                    value={currentDraft.description}
                    onChange={(e) => patchDraft({ description: e.target.value })}
                    placeholder="What is this work, in one line?"
                  />
                </label>
              </div>

              <div className="add-another">
                <span>Do you have another {currentDraft.typeLabel.toLowerCase()}?</span>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={addAnother}
                  disabled={!draftComplete(currentDraft)}
                >
                  Add another
                </button>
              </div>
            </div>
          )}

          {/* Step 3 — time & currency */}
          {step === 3 && (
            <div className="wiz-body">
              <span className="stepno num">Step 3 of 4</span>
              <h3>How should we count?</h3>
              <p className="lead">One base currency for comparisons, and a decision about time.</p>

              <div className="fgrid" style={{ maxWidth: 560, marginBottom: 24 }}>
                <label className="field">
                  <span>Base currency</span>
                  <select
                    value={baseCurrency}
                    onChange={(e) => setBaseCurrency(e.target.value)}
                  >
                    {currencyOptions.map((c) => (
                      <option value={c.code} key={c.code}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="choice-col" role="radiogroup" aria-label="Time tracking">
                <span className="choice">
                  <input
                    type="radio"
                    name="time"
                    id="time-track"
                    checked={trackHours}
                    onChange={() => setTrackHours(true)}
                  />
                  <label htmlFor="time-track">
                    <span className="radio" aria-hidden="true"></span>
                    <span>
                      <h5>
                        Track my hours <small>Recommended</small>
                      </h5>
                      <p>
                        A rough weekly estimate per project is enough. This unlocks your effective
                        hourly rate — the number that shows which work actually pays.
                      </p>
                    </span>
                  </label>
                </span>
                <span className="choice">
                  <input
                    type="radio"
                    name="time"
                    id="time-revenue"
                    checked={!trackHours}
                    onChange={() => setTrackHours(false)}
                  />
                  <label htmlFor="time-revenue">
                    <span className="radio" aria-hidden="true"></span>
                    <span>
                      <h5>Revenue only</h5>
                      <p>
                        Skip hours for now. Rankings will compare income alone. You can switch this
                        on any time.
                      </p>
                    </span>
                  </label>
                </span>
              </div>
            </div>
          )}

          {/* Step 4 — review */}
          {step === 4 && (
            <div className="wiz-body">
              <span className="stepno num">Step 4 of 4</span>
              <h3>Ready to track.</h3>
              <p className="lead">
                {drafts.length === 1 ? 'One project' : `${drafts.length} projects`}, normalised to
                monthly equivalents in {baseCurrency}. Edit anything from the dashboard.
              </p>

              <div className="review">
                {drafts.map((d) => (
                  <ReviewRow key={d.id} draft={d} currency={baseCurrency} />
                ))}
                <div className="rrow total">
                  <span className="rn">Monthly-equivalent total</span>
                  <span className="rv num">{reviewTotal(drafts, baseCurrency)}</span>
                </div>
              </div>

              <p className="wiz-done-note">
                From here the dashboard takes over: it starts comparing effective rates and flags
                where your time is best spent. Every project here can be edited — or removed — later.
              </p>

              {error && (
                <div className="wiz-error" role="alert">
                  <b>Couldn’t finish</b>
                  <p>{error}</p>
                </div>
              )}
            </div>
          )}

          <div className="wiz-foot">
            <span className="hint">{hint}</span>
            <div className="wiz-nav">
              <button
                type="button"
                className="btn ghost"
                onClick={goBack}
                disabled={step === 1 || submitting}
              >
                Back
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={goNext}
                disabled={!canAdvance}
              >
                {nextLabel}
              </button>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

// One review row — the draft's name, a meta line, and its monthly-equivalent (or rate / "from
// entries" when there is no standalone monthly figure).
function ReviewRow({ draft, currency }: { draft: Draft; currency: string }) {
  const amount = parseAmount(draft.amount);
  const monthly = monthlyEquivalent(draft.compensation_model, amount);
  const compLabel = COMP_LABEL[draft.compensation_model];

  let rateSuffix = '';
  if (draft.compensation_model === 'hourly' && amount !== null) {
    rateSuffix = `, ${currency} ${fmt(amount)}/h`;
  } else if (draft.compensation_model === 'fixed' && amount !== null) {
    rateSuffix = `, ${currency} ${fmt(amount)}`;
  }
  const meta = `${draft.typeLabel} · ${compLabel}${rateSuffix} · since ${monthYear(draft.start_date)}`;

  let value: string;
  let sub: string | null = null;
  if (monthly !== null) {
    // Biweekly/weekly are computed conversions → mark approximate; monthly salary is exact.
    const approx = draft.compensation_model !== 'salary_monthly';
    value = `${approx ? '≈ ' : ''}${currency} ${fmt(monthly)}`;
    if (approx) sub = 'per month';
  } else if (draft.compensation_model === 'hourly' && amount !== null) {
    value = `${currency} ${fmt(amount)}/h`;
    sub = 'from hours';
  } else if (draft.compensation_model === 'fixed' && amount !== null) {
    value = `${currency} ${fmt(amount)}`;
    sub = 'one-time';
  } else {
    value = '—';
    sub = 'from entries';
  }

  return (
    <div className="rrow">
      <span className="rn">
        {draft.name.trim() || draft.typeLabel}
        <small>{meta}</small>
      </span>
      <span className="rv num">
        {value}
        {sub && <small>{sub}</small>}
      </span>
    </div>
  );
}

// The monthly-equivalent total across drafts that have a standalone monthly figure. When none do,
// there is nothing to sum, so show an em dash rather than a misleading zero.
function reviewTotal(drafts: Draft[], currency: string): string {
  let total = 0;
  let any = false;
  for (const d of drafts) {
    const m = monthlyEquivalent(d.compensation_model, parseAmount(d.amount));
    if (m !== null) {
      total += m;
      any = true;
    }
  }
  return any ? `${currency} ${fmt(total)}` : '—';
}
