// Onboarding completion + the one-time canvas mood hint, tracked per-user in localStorage
// (ticket 03, v1 — no backend). Keys are namespaced by user id so a second account signing in on
// the same browser gets its own state, and signing out never resurrects the flow for someone who
// already finished it. All access is wrapped: if storage is unavailable we fail *open* (treat the
// user as onboarded) rather than trapping them in the welcome flow.

const onboardedKey = (userId: number) => `vorhaben:onboarded:${userId}`;
const canvasHintKey = (userId: number) => `vorhaben:canvas-hint:${userId}`;

/** Has this user completed (or skipped) onboarding, or already created a project? */
export function isOnboarded(userId: number): boolean {
  try {
    return localStorage.getItem(onboardedKey(userId)) === '1';
  } catch {
    // Storage disabled (private mode) — never trap the user in onboarding.
    return true;
  }
}

/** Mark onboarding complete — set on skip, on starting the first project, or on first app load
 *  for an existing account that already has projects. Idempotent. */
export function markOnboarded(userId: number): void {
  try {
    localStorage.setItem(onboardedKey(userId), '1');
  } catch {
    // Nothing to do — the gate fails open on read, so the flow simply won't re-appear this session.
  }
}

/** Arm the one-time "set today's mood" hint on the canvas, shown after the first project is
 *  created via the welcome flow. */
export function armCanvasHint(userId: number): void {
  try {
    localStorage.setItem(canvasHintKey(userId), 'pending');
  } catch {
    // Optional garnish — a missing hint is not a failure.
  }
}

/** Is the canvas hint still pending (armed and not yet dismissed) for this user? */
export function isCanvasHintPending(userId: number): boolean {
  try {
    return localStorage.getItem(canvasHintKey(userId)) === 'pending';
  } catch {
    return false;
  }
}

/** Retire the canvas hint permanently for this user (dismissed — never returns). */
export function clearCanvasHint(userId: number): void {
  try {
    localStorage.setItem(canvasHintKey(userId), 'seen');
  } catch {
    // Best-effort; the hint is hidden in-memory regardless.
  }
}
