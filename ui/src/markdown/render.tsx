// G-25: Markdown tokens (parse.ts) as React elements. Every piece of the
// message reaches the page as a React text child: no innerHTML, no HTML
// passthrough. A link is an <a> to an https URL only, opened in a new window,
// which the desktop shell turns into its "Open this link in your browser?"
// prompt (desktop/src/main.js openExternal).

import { Fragment, memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useIntl } from 'react-intl';
import { copyText } from '../app/clipboard';
import { textDir, type Dir } from '../app/textDir';
import { hasMarkdown, parse, type Block, type Inline } from './parse';
import '../styles/markdown.css';

type RenderText = (text: string) => ReactNode;

/**
 * The one place the UI renders a link it didn't build itself (the source
 * rule in test/security.test.tsx names this file). The parser only yields
 * https URLs with no spaces, quotes or angle brackets; this checks again,
 * as the desktop shell does (security.js isExternalWebUrl): https, a host,
 * no user name or password. Anything else shows as text.
 */
export function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return null;
    // SL review: no IP literals or loopback names, which point inside the
    // network rather than at a named site (URL has already normalised
    // forms like 0x7f.1 to 127.0.0.1).
    const host = u.hostname.toLowerCase().replace(/\.$/, ''); // 'localhost.' is localhost
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith('[') || host === 'localhost' || host.endsWith('.localhost')) return null;
    return u.href;
  } catch {
    return null;
  }
}

/** How long "Copied" stays on a code block's copy button. */
export const COPIED_MS = 2000;

function Spoiler({ nodes, renderText }: { nodes: Inline[]; renderText: RenderText }) {
  const intl = useIntl();
  const [shown, setShown] = useState(false);
  // The button goes away on reveal: focus moves to the revealed text (UX review).
  const revealed = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (shown) revealed.current?.focus();
  }, [shown]);
  if (shown)
    return (
      <span ref={revealed} tabIndex={-1} className="md-spoiler revealed">
        {inline(nodes, renderText, true)}
      </span>
    );
  // Hidden: a button whose text is out of reach of screen readers, selection
  // and copy (the copied message has the mask instead, plainText()).
  return (
    <button
      type="button"
      className="md-spoiler"
      aria-expanded={false}
      aria-label={intl.formatMessage({ id: 'md.spoiler' })}
      onClick={() => setShown(true)}
    >
      <span aria-hidden="true">{inline(nodes, renderText, false)}</span>
    </button>
  );
}

/** `live`: links can be clicked (false inside a hidden spoiler's button). */
function inline(nodes: Inline[], renderText: RenderText, live: boolean): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text':
        return <Fragment key={i}>{renderText(n.v)}</Fragment>;
      case 'code':
        return (
          <bdi key={i} dir="ltr">
            <code className="md-code">{n.v}</code>
          </bdi>
        );
      case 'link': {
        const href = live ? safeHref(n.v) : null;
        return href ? (
          <a key={i} className="md-link" href={href} target="_blank" rel="noopener noreferrer" dir="ltr">
            {n.v}
          </a>
        ) : (
          <bdi key={i} dir="ltr">
            {n.v}
          </bdi>
        );
      }
      case 'bold':
        return (
          <strong key={i} className="md-bold">
            {inline(n.c, renderText, live)}
          </strong>
        );
      case 'italic':
        return <em key={i}>{inline(n.c, renderText, live)}</em>;
      case 'strike':
        return <s key={i}>{inline(n.c, renderText, live)}</s>;
      case 'spoiler':
        return live ? <Spoiler key={i} nodes={n.c} renderText={renderText} /> : <Fragment key={i}>{inline(n.c, renderText, false)}</Fragment>;
    }
  });
}

function CodeBlock({ code }: { code: string }) {
  const intl = useIntl();
  const [copied, setCopied] = useState(false);
  return (
    <div className="md-code-block" dir="ltr">
      <pre>
        <code>{code}</code>
      </pre>
      <button
        type="button"
        className="md-copy"
        aria-label={intl.formatMessage({ id: copied ? 'md.copied' : 'md.copyCode' })}
        title={intl.formatMessage({ id: 'md.copyCode' })}
        onClick={async () => {
          if (await copyText(code)) {
            setCopied(true);
            setTimeout(() => setCopied(false), COPIED_MS);
          }
        }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="5" y="5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H11" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        {copied && (
          <span className="md-copied" role="status">
            {intl.formatMessage({ id: 'md.copied' })}
          </span>
        )}
      </button>
    </div>
  );
}

function block(b: Block, key: number, uiDir: Dir, renderText: RenderText, trailing: ReactNode): ReactNode {
  if (b.t === 'code')
    return (
      <Fragment key={key}>
        <CodeBlock code={b.v} />
        {trailing && <span className="msg-line">{trailing}</span>}
      </Fragment>
    );
  if (b.t === 'quote') {
    // The bar sits on the start side of the quote's own direction.
    const dir = textDir(b.lines.map((l) => l.raw).join(' '), uiDir);
    return (
      <blockquote key={key} className="md-quote user-text" dir={dir}>
        {b.lines.map((l, i) => (
          <span key={i} className="msg-line" dir={textDir(l.raw, dir)}>
            {inline(l.c, renderText, true)}
            {i === b.lines.length - 1 && trailing}
          </span>
        ))}
      </blockquote>
    );
  }
  return (
    <span key={key} className="msg-line user-text" dir={textDir(b.raw, uiDir)}>
      {inline(b.c, renderText, true)}
      {trailing}
    </span>
  );
}

/**
 * A message body: one `.msg-line` per line (each with its own direction,
 * B17), quotes and code blocks. `renderText` shows the plain runs (the
 * message list's mention chips); `trailing` goes at the end of the last line
 * (the "(edited)" tag).
 */
export const MarkdownBody = memo(function MarkdownBody({
  text,
  uiDir,
  renderText,
  trailing,
}: {
  text: string;
  uiDir: Dir;
  renderText: RenderText;
  trailing?: ReactNode;
}) {
  const blocks = useMemo(() => (hasMarkdown(text) ? parse(text) : text.split('\n').map((l): Block => ({ t: 'line', c: l ? [{ t: 'text', v: l }] : [], raw: l }))), [text]);
  return <>{blocks.map((b, i) => block(b, i, uiDir, renderText, i === blocks.length - 1 ? trailing : null))}</>;
});
