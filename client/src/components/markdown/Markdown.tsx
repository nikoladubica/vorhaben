// The one and only safe-Markdown renderer — and the whole client's single security boundary.
//
// Notes are stored and returned RAW (server/src/routes/notes.ts keeps body_md byte-for-byte),
// so a note body can contain arbitrary HTML: <script>, onerror handlers, javascript: hrefs. This
// component is the ONE place that turns that source into DOM, and it does so through a fixed
// pipeline: marked.parse (GFM — tables + autolinks) → DOMPurify.sanitize → inject. DOMPurify
// strips scripts, event-handler attributes, and dangerous URL schemes, so what reaches the raw
// HTML sink below is always sanitized.
//
// INVARIANT: this file holds the ONLY raw-HTML injection point in client/src (the one React
// prop that bypasses escaping, on the last line). Do not add another anywhere in the client, and
// do not feed this one anything but DOMPurify output — a repo-wide grep for that prop must return
// exactly one hit, right here.

import { useMemo } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

// GFM on: Markdown tables and bare-URL autolinking. Parsing is synchronous (async defaults off),
// but the default overload types the result as string | Promise<string> — pass `async: false` so
// TypeScript resolves it to a plain string.
marked.setOptions({ gfm: true });

// Registered once at module scope (not per render): every sanitized anchor that carries an href
// opens in a new tab with a hardened rel, so a note link can never reach back into the app via
// window.opener. DOMPurify has already vetted the href scheme by the time this runs.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

interface MarkdownProps {
  source: string;
}

export function Markdown({ source }: MarkdownProps) {
  // Parse + sanitize is pure in `source`; memoize so re-renders (e.g. an editor keystroke on a
  // sibling) don't re-run the pipeline unless the text actually changed.
  const html = useMemo(() => {
    const parsed = marked.parse(source, { async: false });
    return DOMPurify.sanitize(parsed);
  }, [source]);

  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}
