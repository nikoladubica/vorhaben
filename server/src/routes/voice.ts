import { Router } from 'express';
import { db } from '../db/index.js';
import { parseTranscript } from '../voice/parse.js';
import { isLlmAvailable, structureTranscript } from '../voice/llm.js';

// Voice capture — feature detection + transcript parsing (§ voice-capture, step 5). Mounted at
// /api/voice behind requireAuth. NEITHER endpoint persists anything: /parse is deliberately
// side-effect free (nothing is saved until the user confirms via the checklists/reminders/events/
// notes endpoints), and /capabilities leaks only a boolean — never the key or model name.
export const voiceRouter = Router();

// The largest transcript the parse endpoint accepts (and the cap mirrored by notes'
// source_transcript column check).
const MAX_TRANSCRIPT = 10_000;

// GET /api/voice/capabilities — { llm: boolean }. true iff an Anthropic key is configured. This is
// the ONLY thing the client learns about the LLM configuration.
voiceRouter.get('/capabilities', (_req, res) => {
  res.json({ llm: isLlmAvailable() });
});

// POST /api/voice/parse — body { transcript }. Loads the user's non-deleted projects, runs the LLM
// path when a key is present (which itself degrades to rules on any error) else the rules parser,
// and returns the ParsedDraft. PERSISTS NOTHING.
voiceRouter.post('/parse', async (req, res) => {
  const userId = req.userId as number;
  const body = (req.body ?? {}) as Record<string, unknown>;

  const transcript = body.transcript;
  if (
    typeof transcript !== 'string' ||
    transcript.length < 1 ||
    transcript.length > MAX_TRANSCRIPT
  ) {
    res.status(422).json({ error: 'validation', fields: { transcript: 'invalid' } });
    return;
  }

  // The user's live projects feed both project-name matching (rules) and the id+name list (LLM).
  const rows = (await db('projects')
    .where('user_id', userId)
    .whereNull('deleted_at')
    .select('id', 'name')) as Array<{ id: number; name: string }>;
  const projects = rows.map((r) => ({ id: Number(r.id), name: String(r.name) }));

  const draft = isLlmAvailable()
    ? await structureTranscript(transcript, projects, userId)
    : parseTranscript(transcript, projects);

  res.json(draft);
});
