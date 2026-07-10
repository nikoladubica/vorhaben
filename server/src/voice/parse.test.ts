import { describe, expect, it } from 'vitest';
import { parseTranscript, type ParsedProject } from './parse.js';

// Deterministic clock so relative dates ("tomorrow", "next Friday") resolve to fixed values.
// 2026-07-09 10:00 local.
const NOW = new Date(2026, 6, 9, 10, 0, 0);
const PROJECTS: ParsedProject[] = [
  { id: 7, name: 'Acme' },
  { id: 9, name: 'Beta Co' },
];

describe('parseTranscript — checklist with project and enumeration', () => {
  it('splits a "checklist for Acme …" into a titled 3-item list attached to Acme', () => {
    const d = parseTranscript(
      'checklist for Acme call the bank then send the invoice and update the spreadsheet',
      PROJECTS,
      NOW,
    );
    expect(d.kind).toBe('checklist');
    expect(d.kindConfidence).toBe('explicit');
    expect(d.items).toEqual([
      'call the bank',
      'send the invoice',
      'update the spreadsheet',
    ]);
    expect(d.projectId).toBe(7);
    expect(d.source).toBe('rules');
    expect(d.datetime).toBeNull();
    expect(d.dateSuggestion).toBe(false);
  });
});

describe('parseTranscript — project targeting by a leading spoken prefix', () => {
  // Regression: a short spoken name ("for Acme") must attach to a longer project ("Acme Redesign")
  // without swallowing the words that follow. Only matching the full name (or a trailing clause)
  // would leave projectId null and fold "for Acme call the bank" into the first item.
  const LONG: ParsedProject[] = [
    { id: 42, name: 'Acme Redesign' },
    { id: 9, name: 'Beta Co' },
  ];

  it('"checklist for Acme …" attaches to "Acme Redesign" and strips the clause', () => {
    const d = parseTranscript(
      'checklist for Acme call the bank then send the invoice and update the spreadsheet',
      LONG,
      NOW,
    );
    expect(d.kind).toBe('checklist');
    expect(d.projectId).toBe(42);
    expect(d.items).toEqual(['call the bank', 'send the invoice', 'update the spreadsheet']);
  });

  it('the full "for Acme Redesign" also attaches and strips both words', () => {
    const d = parseTranscript('remind me to send the report for Acme Redesign tomorrow', LONG, NOW);
    expect(d.kind).toBe('reminder');
    expect(d.projectId).toBe(42);
    expect(d.title).toBe('send the report');
  });

  it('does not mistake a non-project "to …" clause for a project', () => {
    const d = parseTranscript('remind me to invoice the client', LONG, NOW);
    expect(d.projectId).toBeNull();
    expect(d.title).toBe('invoice the client');
  });
});

describe('parseTranscript — reminder with resolved date/time', () => {
  it('"remind me tomorrow at 5 pm to invoice the client" → reminder tomorrow 17:00', () => {
    const d = parseTranscript('remind me tomorrow at 5 pm to invoice the client', PROJECTS, NOW);
    expect(d.kind).toBe('reminder');
    expect(d.kindConfidence).toBe('explicit');
    expect(d.title).toBe('invoice the client');
    expect(d.datetime).toBe('2026-07-10T17:00:00');
    expect(d.dateSuggestion).toBe(false);
    expect(d.projectId).toBeNull();
  });
});

describe('parseTranscript — note default and date suggestion', () => {
  it('"note …" with no date → note, dateSuggestion false', () => {
    const d = parseTranscript('note the client prefers invoices in euros', PROJECTS, NOW);
    expect(d.kind).toBe('note');
    expect(d.body).toBe('the client prefers invoices in euros');
    expect(d.dateSuggestion).toBe(false);
    expect(d.datetime).toBeNull();
  });

  it('the same note plus "next Friday" only *suggests* a reminder (kind stays note)', () => {
    const d = parseTranscript(
      'note the client prefers invoices in euros next Friday',
      PROJECTS,
      NOW,
    );
    expect(d.kind).toBe('note');
    expect(d.dateSuggestion).toBe(true);
    expect(d.datetime).not.toBeNull();
  });
});

describe('parseTranscript — checklist trigger vocabulary', () => {
  it('"make a list …" drafts a checklist', () => {
    const d = parseTranscript('make a list call mom, email the boss, submit the report', PROJECTS, NOW);
    expect(d.kind).toBe('checklist');
    expect(d.kindConfidence).toBe('explicit');
    expect(d.items).toEqual(['call mom', 'email the boss', 'submit the report']);
  });

  it('"make a checklist for Acme …" drafts a checklist attached to the project', () => {
    const d = parseTranscript('make a checklist for Acme call the bank and send the invoice', PROJECTS, NOW);
    expect(d.kind).toBe('checklist');
    expect(d.projectId).toBe(7);
    expect(d.items).toEqual(['call the bank', 'send the invoice']);
  });

  it('bare "to do …" (space, no "list") drafts a checklist', () => {
    const d = parseTranscript('to do call the bank then send the invoice', PROJECTS, NOW);
    expect(d.kind).toBe('checklist');
    expect(d.kindConfidence).toBe('explicit');
    expect(d.items).toEqual(['call the bank', 'send the invoice']);
  });

  it('a bare "list …" (no make-verb) is NOT hijacked as a checklist trigger', () => {
    const d = parseTranscript('list the payment we received last week', PROJECTS, NOW);
    expect(d.kind).toBe('note');
  });
});

describe('parseTranscript — inferred checklist without a trigger word', () => {
  it('a bare enumeration becomes an inferred checklist', () => {
    const d = parseTranscript('call mom, email the boss, submit the report', PROJECTS, NOW);
    expect(d.kind).toBe('checklist');
    expect(d.kindConfidence).toBe('inferred');
    expect(d.items).toHaveLength(3);
  });
});
