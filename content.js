/**
 * Transcript — Export for Claude
 * Content script: runs on claude.ai, reads the DOM of the currently open
 * conversation, and turns it into a structured object that popup.js
 * can ask to be rendered as Markdown / HTML / JSON and downloaded.
 *
 * NOTE ON SELECTORS: claude.ai is a frequently-updated single-page app and
 * doesn't expose a public DOM API. The selectors below are layered with
 * fallbacks on purpose — if Anthropic changes class names, update the
 * arrays in USER_SELECTORS / ASSISTANT_SELECTORS first.
 */

const USER_SELECTORS = [
  '[data-testid="user-message"]',
  '.font-user-message',
  'div[class*="font-user-message"]'
];

const ASSISTANT_SELECTORS = [
  '[data-testid="chat-message"]',
  '.font-claude-message',
  'div[class*="font-claude-message"]'
];

function uniqueTopLevelNodes(selectors) {
  const set = new Set();
  selectors.forEach((sel) => {
    document.querySelectorAll(sel).forEach((el) => set.add(el));
  });
  const nodes = Array.from(set);
  // Drop any node whose ancestor is also in the set (avoid double-counting).
  return nodes.filter((n) => !nodes.some((other) => other !== n && other.contains(n)));
}

function collectMessageNodes() {
  const users = uniqueTopLevelNodes(USER_SELECTORS).map((el) => ({ el, role: 'user' }));
  const assistants = uniqueTopLevelNodes(ASSISTANT_SELECTORS).map((el) => ({ el, role: 'assistant' }));
  const all = [...users, ...assistants];
  all.sort((a, b) => {
    const pos = a.el.compareDocumentPosition(b.el);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
  return all;
}

function isArtifactCard(el) {
  if (!el.getAttribute) return false;
  const cls = el.className && typeof el.className === 'string' ? el.className : '';
  if (/artifact/i.test(cls)) return true;
  if (el.querySelector && el.querySelector('[class*="artifact" i], [data-testid*="artifact" i]')) return true;
  return false;
}

function artifactTitle(el) {
  const t = el.querySelector('h1, h2, h3, [class*="title" i]');
  const text = t && t.innerText && t.innerText.trim();
  return text || 'Untitled artifact';
}

function codeBlockFromPre(pre) {
  const codeEl = pre.querySelector('code') || pre;
  let text = codeEl.innerText || '';
  text = text.replace(/\n+$/, '');
  let lang = '';
  const cls = codeEl.className || '';
  const m = cls.match(/language-([a-zA-Z0-9_+-]+)/);
  if (m) lang = m[1];
  if (!lang) {
    const header = pre.parentElement && pre.parentElement.querySelector('[class*="language" i]');
    if (header && header.innerText && header.innerText.trim().length < 20) {
      lang = header.innerText.trim().toLowerCase();
    }
  }
  return { type: 'code', lang, text };
}

function listFromEl(el) {
  const ordered = el.tagName === 'OL';
  const items = Array.from(el.children)
    .filter((li) => li.tagName === 'LI')
    .map((li) => li.innerText.trim())
    .filter(Boolean);
  return { type: 'list', ordered, items };
}

function tableFromEl(el) {
  const rows = Array.from(el.querySelectorAll('tr')).map((tr) =>
    Array.from(tr.children).map((cell) => cell.innerText.trim())
  );
  return { type: 'table', rows };
}

function walk(node, blocks, depth) {
  if (depth > 12) return; // safety valve against pathological nesting
  for (const child of Array.from(node.children)) {
    const tag = child.tagName;
    if (tag === 'PRE') {
      blocks.push(codeBlockFromPre(child));
    } else if (tag === 'UL' || tag === 'OL') {
      const l = listFromEl(child);
      if (l.items.length) blocks.push(l);
    } else if (tag === 'BLOCKQUOTE') {
      const t = child.innerText.trim();
      if (t) blocks.push({ type: 'quote', text: t });
    } else if (/^H[1-6]$/.test(tag)) {
      const t = child.innerText.trim();
      if (t) blocks.push({ type: 'heading', level: Number(tag[1]), text: t });
    } else if (tag === 'P') {
      const t = child.innerText.trim();
      if (t) blocks.push({ type: 'paragraph', text: t });
    } else if (tag === 'TABLE') {
      const tbl = tableFromEl(child);
      if (tbl.rows.length) blocks.push(tbl);
    } else if (isArtifactCard(child)) {
      blocks.push({ type: 'artifact', title: artifactTitle(child) });
    } else if (child.children.length) {
      walk(child, blocks, depth + 1);
    } else {
      const t = child.innerText && child.innerText.trim();
      if (t) blocks.push({ type: 'paragraph', text: t });
    }
  }
}

function elementToBlocks(el) {
  const blocks = [];
  walk(el, blocks, 0);
  if (!blocks.length) {
    const t = el.innerText && el.innerText.trim();
    if (t) blocks.push({ type: 'paragraph', text: t });
  }
  return blocks;
}

function getConversationTitle() {
  const active = document.querySelector('[aria-current="page"]');
  if (active && active.innerText && active.innerText.trim()) {
    return active.innerText.trim().split('\n')[0];
  }
  const docTitle = document.title.replace(/\s*[-–|]\s*Claude.*$/i, '').trim();
  return docTitle || 'Claude Conversation';
}

function extractConversation() {
  const nodes = collectMessageNodes();
  const messages = nodes.map(({ el, role }) => ({
    role,
    blocks: elementToBlocks(el)
  }));
  return {
    title: getConversationTitle(),
    url: location.href,
    exportedAt: new Date().toISOString(),
    messages
  };
}

// ---------- Rendering ----------

function slugify(str) {
  return (
    str
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'claude-conversation'
  );
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function blockToMarkdown(block) {
  switch (block.type) {
    case 'heading':
      return `${'#'.repeat(Math.min(block.level + 1, 6))} ${block.text}`;
    case 'paragraph':
      return block.text;
    case 'list':
      return block.items
        .map((item, i) => (block.ordered ? `${i + 1}. ${item}` : `- ${item}`))
        .join('\n');
    case 'code':
      return '```' + (block.lang || '') + '\n' + block.text + '\n```';
    case 'quote':
      return block.text
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
    case 'artifact':
      return `> 📎 **Artifact:** ${block.title} *(open the conversation in Claude.ai to view it in full)*`;
    case 'table': {
      if (!block.rows.length) return '';
      const [header, ...rest] = block.rows;
      const headerRow = `| ${header.join(' | ')} |`;
      const sepRow = `| ${header.map(() => '---').join(' | ')} |`;
      const bodyRows = rest.map((r) => `| ${r.join(' | ')} |`);
      return [headerRow, sepRow, ...bodyRows].join('\n');
    }
    default:
      return '';
  }
}

function toMarkdown(conv) {
  const lines = [
    `# ${conv.title}`,
    '',
    `*Exported from [Claude.ai](${conv.url}) on ${formatDate(conv.exportedAt)} — ${conv.messages.length} messages*`,
    '',
    '---',
    ''
  ];
  conv.messages.forEach((msg) => {
    lines.push(msg.role === 'user' ? '### 🧑 You' : '### ✦ Claude');
    lines.push('');
    msg.blocks.forEach((b) => {
      const md = blockToMarkdown(b);
      if (md) {
        lines.push(md);
        lines.push('');
      }
    });
    lines.push('---');
    lines.push('');
  });
  return lines.join('\n');
}

function blockToHtml(block) {
  switch (block.type) {
    case 'heading':
      return `<h${Math.min(block.level + 1, 6)}>${escapeHtml(block.text)}</h${Math.min(block.level + 1, 6)}>`;
    case 'paragraph':
      return `<p>${escapeHtml(block.text).replace(/\n/g, '<br>')}</p>`;
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      const items = block.items.map((i) => `<li>${escapeHtml(i)}</li>`).join('');
      return `<${tag}>${items}</${tag}>`;
    }
    case 'code':
      return `<div class="code-block">${block.lang ? `<div class="code-lang">${escapeHtml(block.lang)}</div>` : ''}<pre><code>${escapeHtml(block.text)}</code></pre></div>`;
    case 'quote':
      return `<blockquote>${escapeHtml(block.text).replace(/\n/g, '<br>')}</blockquote>`;
    case 'artifact':
      return `<div class="artifact-card"><span class="artifact-label">FIG — Artifact</span><span class="artifact-title">${escapeHtml(block.title)}</span></div>`;
    case 'table': {
      if (!block.rows.length) return '';
      const [header, ...rest] = block.rows;
      const thead = `<thead><tr>${header.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>`;
      const tbody = `<tbody>${rest
        .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`)
        .join('')}</tbody>`;
      return `<table>${thead}${tbody}</table>`;
    }
    default:
      return '';
  }
}

function toHTML(conv) {
  const turns = conv.messages
    .map((msg) => {
      const roleClass = msg.role === 'user' ? 'turn-user' : 'turn-claude';
      const label = msg.role === 'user' ? 'You' : 'Claude';
      const body = msg.blocks.map(blockToHtml).join('\n');
      return `<section class="turn ${roleClass}">
        <div class="rail"></div>
        <div class="turn-body">
          <div class="speaker">${label}</div>
          <div class="content">${body}</div>
        </div>
      </section>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(conv.title)} — Transcript</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --paper: #efebde;
    --paper-inset: #e6e1d0;
    --ink: #2b2820;
    --ink-soft: #5c5748;
    --rule: #c9c2ae;
    --user: #35586b;
    --user-tint: #e2eaee;
    --claude: #4c6b4f;
    --claude-tint: #e6ede4;
    --accent: #b3811f;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--paper);
    color: var(--ink);
    font-family: 'Inter', sans-serif;
    line-height: 1.6;
  }
  .page {
    max-width: 760px;
    margin: 0 auto;
    padding: 64px 32px 96px;
  }
  .title-block {
    text-align: left;
    margin-bottom: 8px;
  }
  .eyebrow {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: 14px;
  }
  h1.doc-title {
    font-family: 'Fraunces', serif;
    font-weight: 600;
    font-size: 42px;
    line-height: 1.15;
    margin: 0 0 18px;
    letter-spacing: -0.01em;
  }
  .meta {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: var(--ink-soft);
    margin-bottom: 8px;
  }
  .meta a { color: var(--ink-soft); }
  .rule-double {
    height: 0;
    border-top: 1px solid var(--rule);
    border-bottom: 3px solid var(--rule);
    margin: 32px 0 40px;
  }
  .turn {
    display: flex;
    gap: 20px;
    padding: 22px 0;
    border-bottom: 1px solid var(--rule);
  }
  .turn:last-child { border-bottom: none; }
  .rail {
    flex: 0 0 4px;
    border-radius: 2px;
    align-self: stretch;
  }
  .turn-user .rail { background: var(--user); }
  .turn-claude .rail { background: var(--claude); }
  .turn-body { flex: 1; min-width: 0; }
  .speaker {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    margin-bottom: 10px;
  }
  .turn-user .speaker { color: var(--user); }
  .turn-claude .speaker { color: var(--claude); }
  .content h2, .content h3, .content h4 {
    font-family: 'Fraunces', serif;
    font-weight: 600;
    margin: 20px 0 10px;
  }
  .content p { margin: 0 0 14px; }
  .content ul, .content ol { margin: 0 0 14px; padding-left: 22px; }
  .content li { margin-bottom: 4px; }
  .content blockquote {
    margin: 0 0 14px;
    padding: 10px 16px;
    border-left: 3px solid var(--accent);
    background: var(--paper-inset);
    font-style: italic;
    color: var(--ink-soft);
  }
  .code-block {
    margin: 0 0 14px;
    background: #23211b;
    border-radius: 8px;
    overflow: hidden;
  }
  .code-lang {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #cdbf9a;
    background: #2f2c22;
    padding: 6px 14px;
  }
  .code-block pre {
    margin: 0;
    padding: 14px 16px;
    overflow-x: auto;
  }
  .code-block code {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    color: #f2ecd8;
    white-space: pre;
  }
  .artifact-card {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0 0 14px;
    padding: 12px 16px;
    background: var(--paper-inset);
    border: 1px dashed var(--rule);
    border-radius: 6px;
  }
  .artifact-label {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--accent);
  }
  .artifact-title {
    font-family: 'Fraunces', serif;
    font-weight: 600;
    font-size: 15px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 0 0 14px;
    font-size: 14px;
  }
  th, td {
    text-align: left;
    padding: 8px 10px;
    border-bottom: 1px solid var(--rule);
  }
  th {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--ink-soft);
  }
  footer {
    margin-top: 48px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--ink-soft);
    text-align: center;
  }
  @media print {
    body { background: white; }
    .turn { break-inside: avoid; }
  }
</style>
</head>
<body>
  <div class="page">
    <div class="title-block">
      <div class="eyebrow">Transcript</div>
      <h1 class="doc-title">${escapeHtml(conv.title)}</h1>
      <div class="meta">${conv.messages.length} messages · exported ${escapeHtml(formatDate(conv.exportedAt))}</div>
      <div class="meta"><a href="${escapeHtml(conv.url)}">${escapeHtml(conv.url)}</a></div>
    </div>
    <div class="rule-double"></div>
    ${turns}
    <footer>Exported with Transcript — Export for Claude</footer>
  </div>
</body>
</html>`;
}

function toJSON(conv) {
  const withText = {
    ...conv,
    messages: conv.messages.map((m) => ({
      ...m,
      text: m.blocks.map((b) => blockToMarkdown(b)).join('\n\n')
    }))
  };
  return JSON.stringify(withText, null, 2);
}

function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'EXPORT') return;
  try {
    const conv = extractConversation();
    if (!conv.messages.length) {
      sendResponse({ success: false, error: 'no_messages' });
      return;
    }
    let content, mime, ext;
    if (msg.format === 'markdown') {
      content = toMarkdown(conv);
      mime = 'text/markdown';
      ext = 'md';
    } else if (msg.format === 'html') {
      content = toHTML(conv);
      mime = 'text/html';
      ext = 'html';
    } else {
      content = toJSON(conv);
      mime = 'application/json';
      ext = 'json';
    }
    const filename = `${slugify(conv.title)}-transcript.${ext}`;
    downloadFile(filename, content, mime);
    sendResponse({ success: true, count: conv.messages.length, filename });
  } catch (e) {
    sendResponse({ success: false, error: e.message });
  }
});
