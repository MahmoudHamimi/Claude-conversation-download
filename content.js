/**
 * Transcript — Export for Claude (Sidebar Edition)
 * Content script: runs on claude.ai, reads the DOM of the currently open
 * conversation, and turns it into a structured object that can be rendered
 * as Markdown / HTML / JSON / PDF and downloaded.
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

// =============================================================================
// SIDEBAR UI
// =============================================================================

const SB_ID = 'transcript-export-sidebar';
const SB_TOGGLE_ID = 'transcript-export-toggle';
const SB_STYLE_ID = 'transcript-export-styles';

function injectSidebarStyles() {
  if (document.getElementById(SB_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = SB_STYLE_ID;
  style.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');

    #${SB_ID} {
      position: fixed;
      top: 0;
      right: -400px;
      width: 400px;
      height: 100vh;
      background: #efebde;
      border-left: 1px solid #c9c2ae;
      z-index: 2147483647;
      transition: right 0.35s cubic-bezier(0.4, 0, 0.2, 1);
      display: flex;
      flex-direction: column;
      font-family: 'Inter', sans-serif;
      color: #2b2820;
      box-shadow: -8px 0 32px rgba(0,0,0,0.12);
    }
    #${SB_ID}.open {
      right: 0;
    }
    #${SB_ID} * {
      box-sizing: border-box;
    }

    .ts-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 18px 20px 14px;
      border-bottom: 1px solid #c9c2ae;
      background: #e6e1d0;
      flex-shrink: 0;
    }
    .ts-header-title {
      font-family: 'Fraunces', serif;
      font-weight: 700;
      font-size: 22px;
      letter-spacing: -0.01em;
    }
    .ts-header-close {
      width: 32px;
      height: 32px;
      border-radius: 8px;
      border: 1px solid #c9c2ae;
      background: #efebde;
      color: #5c5748;
      font-size: 20px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      line-height: 1;
      padding: 0;
    }
    .ts-header-close:hover {
      background: #c9c2ae;
      color: #2b2820;
    }

    .ts-scroll {
      flex: 1;
      overflow-y: auto;
      padding: 16px 18px;
    }
    .ts-scroll::-webkit-scrollbar {
      width: 6px;
    }
    .ts-scroll::-webkit-scrollbar-thumb {
      background: #c9c2ae;
      border-radius: 3px;
    }

    .ts-section {
      margin-bottom: 22px;
    }
    .ts-section-title {
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: #b3811f;
      margin-bottom: 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .ts-summary-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .ts-pair {
      background: #e6e1d0;
      border: 1px solid #c9c2ae;
      border-radius: 10px;
      padding: 12px 14px;
      font-size: 12.5px;
      line-height: 1.5;
    }
    .ts-pair-q, .ts-pair-a {
      display: flex;
      gap: 8px;
    }
    .ts-pair-q {
      margin-bottom: 8px;
      padding-bottom: 8px;
      border-bottom: 1px dashed #c9c2ae;
    }
    .ts-pair-label {
      font-family: 'JetBrains Mono', monospace;
      font-size: 9px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      font-weight: 600;
      flex-shrink: 0;
      margin-top: 2px;
    }
    .ts-pair-q .ts-pair-label { color: #35586b; }
    .ts-pair-a .ts-pair-label { color: #4c6b4f; }
    .ts-pair-text {
      color: #2b2820;
      display: -webkit-box;
      -webkit-line-clamp: 4;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .ts-pair-empty {
      color: #6b6656;
      font-style: italic;
      text-align: center;
      padding: 20px;
      font-size: 12px;
    }

    .ts-formats {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .ts-format-btn {
      display: flex;
      align-items: stretch;
      gap: 10px;
      width: 100%;
      padding: 10px 12px;
      background: #e6e1d0;
      border: 1px solid #c9c2ae;
      border-radius: 8px;
      cursor: pointer;
      text-align: left;
      font-family: inherit;
      transition: transform 0.08s ease, border-color 0.15s ease, background 0.15s ease;
    }
    .ts-format-btn:hover {
      border-color: #b3811f;
      background: #e2ddd0;
      transform: translateX(2px);
    }
    .ts-format-btn:active {
      transform: translateX(0);
    }
    .ts-format-rail {
      flex: 0 0 3px;
      border-radius: 2px;
      align-self: stretch;
    }
    .ts-format-rail.html { background: #4c6b4f; }
    .ts-format-rail.md { background: #35586b; }
    .ts-format-rail.json { background: #b3811f; }
    .ts-format-rail.pdf { background: #a13d3d; }
    .ts-format-name {
      font-family: 'Fraunces', serif;
      font-weight: 600;
      font-size: 14px;
    }
    .ts-format-desc {
      font-size: 11px;
      color: #6b6656;
    }

    .ts-status {
      min-height: 16px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      line-height: 1.5;
      margin-top: 4px;
    }
    .ts-status.pending { color: #6b6656; }
    .ts-status.success { color: #4c6b4f; }
    .ts-status.error { color: #a13d3d; }

    .ts-footer {
      font-size: 10px;
      color: #6b6656;
      text-align: center;
      padding: 10px 0 4px;
    }

    .ts-refresh-btn {
      background: none;
      border: none;
      color: #b3811f;
      cursor: pointer;
      font-size: 14px;
      padding: 2px 6px;
      border-radius: 4px;
      line-height: 1;
    }
    .ts-refresh-btn:hover {
      background: #c9c2ae;
    }

    #${SB_TOGGLE_ID} {
      position: fixed;
      bottom: 24px;
      right: 24px;
      width: 52px;
      height: 52px;
      border-radius: 50%;
      background: #b3811f;
      color: #fff;
      border: none;
      cursor: pointer;
      z-index: 2147483646;
      box-shadow: 0 4px 16px rgba(0,0,0,0.2);
      font-size: 22px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.2s ease, background 0.2s ease;
      font-family: 'Inter', sans-serif;
      padding: 0;
    }
    #${SB_TOGGLE_ID}:hover {
      transform: scale(1.08);
      background: #9a6e18;
    }
    #${SB_TOGGLE_ID}:active {
      transform: scale(0.96);
    }
    #${SB_TOGGLE_ID}.hidden {
      display: none !important;
    }
  `;
  document.head.appendChild(style);
}

function createSidebar() {
  if (document.getElementById(SB_ID)) return;

  const sidebar = document.createElement('div');
  sidebar.id = SB_ID;
  sidebar.innerHTML = `
    <div class="ts-header">
      <div class="ts-header-title">Transcript</div>
      <button class="ts-header-close" title="Close sidebar">&times;</button>
    </div>
    <div class="ts-scroll">
      <div class="ts-section">
        <div class="ts-section-title">
          <span>Conversation Summary</span>
          <button class="ts-refresh-btn" id="ts-refresh" title="Refresh summary">&#8635;</button>
        </div>
        <div id="ts-summary" class="ts-summary-list">
          <div class="ts-pair-empty">Open a conversation to see a summary.</div>
        </div>
      </div>
      <div class="ts-section">
        <div class="ts-section-title">Export</div>
        <div class="ts-formats">
          <button class="ts-format-btn" data-format="html">
            <span class="ts-format-rail html"></span>
            <span>
              <div class="ts-format-name">Styled HTML</div>
              <div class="ts-format-desc">Manuscript layout, ready to print or share</div>
            </span>
          </button>
          <button class="ts-format-btn" data-format="markdown">
            <span class="ts-format-rail md"></span>
            <span>
              <div class="ts-format-name">Markdown</div>
              <div class="ts-format-desc">Clean .md for notes apps &amp; repos</div>
            </span>
          </button>
          <button class="ts-format-btn" data-format="json">
            <span class="ts-format-rail json"></span>
            <span>
              <div class="ts-format-name">JSON</div>
              <div class="ts-format-desc">Structured data for your own tooling</div>
            </span>
          </button>
          <button class="ts-format-btn" data-format="pdf">
            <span class="ts-format-rail pdf"></span>
            <span>
              <div class="ts-format-name">PDF</div>
              <div class="ts-format-desc">Print-ready document via your browser</div>
            </span>
          </button>
        </div>
      </div>
      <div id="ts-status" class="ts-status"></div>
      <div class="ts-footer">Runs entirely in your browser — nothing leaves the page.</div>
    </div>
  `;
  document.body.appendChild(sidebar);

  sidebar.querySelector('.ts-header-close').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSidebar();
  });

  sidebar.querySelectorAll('.ts-format-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      doExport(btn.dataset.format);
    });
  });

  sidebar.querySelector('#ts-refresh').addEventListener('click', (e) => {
    e.stopPropagation();
    refreshSummary();
  });
}

function createToggle() {
  if (document.getElementById(SB_TOGGLE_ID)) return;
  const btn = document.createElement('button');
  btn.id = SB_TOGGLE_ID;
  btn.innerHTML = '&#128196;';
  btn.title = 'Toggle Transcript sidebar';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSidebar();
  });
  document.body.appendChild(btn);
}

function toggleSidebar() {
  const sb = document.getElementById(SB_ID);
  if (!sb) {
    initSidebar();
    setTimeout(() => {
      document.getElementById(SB_ID)?.classList.add('open');
      refreshSummary();
    }, 50);
    return;
  }
  sb.classList.toggle('open');
  if (sb.classList.contains('open')) {
    refreshSummary();
  }
}

function setStatus(text, kind) {
  const el = document.getElementById('ts-status');
  if (!el) return;
  el.textContent = text;
  el.className = 'ts-status' + (kind ? ` ${kind}` : '');
}

function getMessagePreview(blocks, maxLen = 200) {
  const texts = [];
  for (const b of blocks) {
    if (b.type === 'paragraph' || b.type === 'heading') {
      texts.push(b.text);
    } else if (b.type === 'list' && b.items.length) {
      texts.push('• ' + b.items[0]);
    } else if (b.type === 'code') {
      texts.push('`code`');
    }
    const joined = texts.join(' ');
    if (joined.length > maxLen) {
      return joined.slice(0, maxLen) + '…';
    }
  }
  return texts.join(' ').trim() || '(empty)';
}

function buildSummary(conv) {
  const pairs = [];
  let current = null;

  for (const msg of conv.messages) {
    if (msg.role === 'user') {
      if (current) pairs.push(current);
      current = {
        question: getMessagePreview(msg.blocks, 160),
        answer: ''
      };
    } else if (msg.role === 'assistant' && current) {
      current.answer = getMessagePreview(msg.blocks, 260);
    }
  }
  if (current) pairs.push(current);
  return pairs;
}

function renderSummary(pairs) {
  const container = document.getElementById('ts-summary');
  if (!container) return;

  if (!pairs.length) {
    container.innerHTML = '<div class="ts-pair-empty">No messages found. Open a conversation with at least one reply.</div>';
    return;
  }

  container.innerHTML = pairs.map((p, i) => `
    <div class="ts-pair">
      <div class="ts-pair-q">
        <span class="ts-pair-label">Q${i + 1}</span>
        <span class="ts-pair-text">${escapeHtml(p.question)}</span>
      </div>
      <div class="ts-pair-a">
        <span class="ts-pair-label">A${i + 1}</span>
        <span class="ts-pair-text">${escapeHtml(p.answer || '…')}</span>
      </div>
    </div>
  `).join('');
}

function refreshSummary() {
  try {
    const conv = extractConversation();
    const pairs = buildSummary(conv);
    renderSummary(pairs);
  } catch (e) {
    renderSummary([]);
  }
}

async function doExport(format) {
  setStatus('Reading conversation…', 'pending');

  try {
    const conv = extractConversation();
    if (!conv.messages.length) {
      setStatus('No messages found. Open a conversation first.', 'error');
      return;
    }

    let content, mime, ext;
    if (format === 'markdown') {
      content = toMarkdown(conv);
      mime = 'text/markdown';
      ext = 'md';
    } else if (format === 'html') {
      content = toHTML(conv);
      mime = 'text/html';
      ext = 'html';
    } else if (format === 'json') {
      content = toJSON(conv);
      mime = 'application/json';
      ext = 'json';
    } else if (format === 'pdf') {
      content = toHTML(conv);
      const blob = new Blob([content], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const win = window.open(url, '_blank');
      const tryPrint = () => {
        if (win && win.document && win.document.readyState === 'complete') {
          win.print();
          setTimeout(() => URL.revokeObjectURL(url), 60000);
        } else {
          setTimeout(tryPrint, 300);
        }
      };
      setTimeout(tryPrint, 500);
      setStatus(`Opened ${conv.messages.length} messages in print view — choose "Save as PDF"`, 'success');
      return;
    } else {
      setStatus('Unknown format.', 'error');
      return;
    }

    const filename = `${slugify(conv.title)}-transcript.${ext}`;
    downloadFile(filename, content, mime);
    setStatus(`Saved ${conv.messages.length} messages → ${filename}`, 'success');
  } catch (e) {
    setStatus(`Export failed: ${e.message}`, 'error');
  }
}

function initSidebar() {
  injectSidebarStyles();
  createSidebar();
  createToggle();
}

// Auto-init when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSidebar);
} else {
  initSidebar();
}

// ---------- Message handling ----------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'TOGGLE_SIDEBAR') {
    toggleSidebar();
    sendResponse({ success: true });
    return;
  }

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
    } else if (msg.format === 'json') {
      content = toJSON(conv);
      mime = 'application/json';
      ext = 'json';
    } else if (msg.format === 'pdf') {
      content = toHTML(conv);
      const blob = new Blob([content], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const win = window.open(url, '_blank');
      const tryPrint = () => {
        if (win && win.document && win.document.readyState === 'complete') {
          win.print();
          setTimeout(() => URL.revokeObjectURL(url), 60000);
        } else {
          setTimeout(tryPrint, 300);
        }
      };
      setTimeout(tryPrint, 500);
      sendResponse({ success: true, count: conv.messages.length, filename: 'print-view.html' });
      return;
    } else {
      sendResponse({ success: false, error: 'Unknown format' });
      return;
    }
    const filename = `${slugify(conv.title)}-transcript.${ext}`;
    downloadFile(filename, content, mime);
    sendResponse({ success: true, count: conv.messages.length, filename });
  } catch (e) {
    sendResponse({ success: false, error: e.message });
  }
});
