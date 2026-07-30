/**
 * Transcript — Export for Claude (Sidebar Edition v1.2)
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
  if (depth > 12) return;
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

// ---------- Rendering utilities ----------

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'claude-conversation';
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function blockToMarkdown(block) {
  switch (block.type) {
    case 'heading': return `${'#'.repeat(Math.min(block.level + 1, 6))} ${block.text}`;
    case 'paragraph': return block.text;
    case 'list': return block.items.map((item, i) => (block.ordered ? `${i + 1}. ${item}` : `- ${item}`)).join('\n');
    case 'code': return '```' + (block.lang || '') + '\n' + block.text + '\n```';
    case 'quote': return block.text.split('\n').map((l) => `> ${l}`).join('\n');
    case 'artifact': return `> \uD83D\uDCCE **Artifact:** ${block.title} *(open the conversation in Claude.ai to view it in full)*`;
    case 'table': {
      if (!block.rows.length) return '';
      const [header, ...rest] = block.rows;
      const headerRow = `| ${header.join(' | ')} |`;
      const sepRow = `| ${header.map(() => '---').join(' | ')} |`;
      const bodyRows = rest.map((r) => `| ${r.join(' | ')} |`);
      return [headerRow, sepRow, ...bodyRows].join('\n');
    }
    default: return '';
  }
}

function toMarkdown(conv) {
  const lines = [
    `# ${conv.title}`, '',
    `*Exported from [Claude.ai](${conv.url}) on ${formatDate(conv.exportedAt)} \u2014 ${conv.messages.length} messages*`, '', '---', ''
  ];
  conv.messages.forEach((msg) => {
    lines.push(msg.role === 'user' ? '### \uD83E\uDDD1 You' : '### \u2726 Claude');
    lines.push('');
    msg.blocks.forEach((b) => { const md = blockToMarkdown(b); if (md) { lines.push(md); lines.push(''); } });
    lines.push('---'); lines.push('');
  });
  return lines.join('\n');
}

function blockToHtml(block) {
  switch (block.type) {
    case 'heading': return `<h${Math.min(block.level + 1, 6)}>${escapeHtml(block.text)}</h${Math.min(block.level + 1, 6)}>`;
    case 'paragraph': return `<p>${escapeHtml(block.text).replace(/\n/g, '<br>')}</p>`;
    case 'list': { const tag = block.ordered ? 'ol' : 'ul'; const items = block.items.map((i) => `<li>${escapeHtml(i)}</li>`).join(''); return `<${tag}>${items}</${tag}>`; }
    case 'code': return `<div class="code-block">${block.lang ? `<div class="code-lang">${escapeHtml(block.lang)}</div>` : ''}<pre><code>${escapeHtml(block.text)}</code></pre></div>`;
    case 'quote': return `<blockquote>${escapeHtml(block.text).replace(/\n/g, '<br>')}</blockquote>`;
    case 'artifact': return `<div class="artifact-card"><span class="artifact-label">FIG \u2014 Artifact</span><span class="artifact-title">${escapeHtml(block.title)}</span></div>`;
    case 'table': {
      if (!block.rows.length) return '';
      const [header, ...rest] = block.rows;
      const thead = `<thead><tr>${header.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>`;
      const tbody = `<tbody>${rest.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
      return `<table>${thead}${tbody}</table>`;
    }
    default: return '';
  }
}

function toHTML(conv) {
  const turns = conv.messages.map((msg) => {
    const roleClass = msg.role === 'user' ? 'turn-user' : 'turn-claude';
    const label = msg.role === 'user' ? 'You' : 'Claude';
    const body = msg.blocks.map(blockToHtml).join('\n');
    return `<section class="turn ${roleClass}"><div class="rail"></div><div class="turn-body"><div class="speaker">${label}</div><div class="content">${body}</div></div></section>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(conv.title)} \u2014 Transcript</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --paper: #FAFAF8;
    --paper-inset: #F0EFEA;
    --ink: #111111;
    --ink-soft: #6B6B6B;
    --rule: #E5E5E0;
    --user: #2563EB;
    --user-tint: #EFF6FF;
    --claude: #059669;
    --claude-tint: #ECFDF5;
    --accent: #E57035;
    --accent-tint: #FFF1EB;
    --code-bg: #1C1C1C;
    --code-text: #F5F5F0;
    --code-lang-bg: #2A2A2A;
    --code-lang-text: #C9C9C0;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper: #111111;
      --paper-inset: #1C1C1C;
      --ink: #FAFAF8;
      --ink-soft: #A0A0A0;
      --rule: #2A2A2A;
      --user: #60A5FA;
      --user-tint: #1E3A5F;
      --claude: #34D399;
      --claude-tint: #064E3B;
      --accent: #F0885C;
      --accent-tint: #3D1F12;
      --code-bg: #0A0A0A;
      --code-text: #F5F5F0;
      --code-lang-bg: #1C1C1C;
      --code-lang-text: #A0A0A0;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink); font-family: 'Inter', sans-serif; line-height: 1.6; }
  .page { max-width: 760px; margin: 0 auto; padding: 64px 32px 96px; }
  .title-block { text-align: left; margin-bottom: 8px; }
  .eyebrow { font-family: 'JetBrains Mono', monospace; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--accent); margin-bottom: 14px; }
  h1.doc-title { font-weight: 600; font-size: 42px; line-height: 1.15; margin: 0 0 18px; letter-spacing: -0.02em; }
  .meta { font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--ink-soft); margin-bottom: 8px; }
  .meta a { color: var(--ink-soft); }
  .rule-double { height: 0; border-top: 1px solid var(--rule); border-bottom: 3px solid var(--rule); margin: 32px 0 40px; }
  .turn { display: flex; gap: 20px; padding: 22px 0; border-bottom: 1px solid var(--rule); }
  .turn:last-child { border-bottom: none; }
  .rail { flex: 0 0 4px; border-radius: 2px; align-self: stretch; }
  .turn-user .rail { background: var(--user); }
  .turn-claude .rail { background: var(--claude); }
  .turn-body { flex: 1; min-width: 0; }
  .speaker { font-family: 'JetBrains Mono', monospace; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; margin-bottom: 10px; }
  .turn-user .speaker { color: var(--user); }
  .turn-claude .speaker { color: var(--claude); }
  .content h2, .content h3, .content h4 { font-weight: 600; margin: 20px 0 10px; }
  .content p { margin: 0 0 14px; }
  .content ul, .content ol { margin: 0 0 14px; padding-left: 22px; }
  .content li { margin-bottom: 4px; }
  .content blockquote { margin: 0 0 14px; padding: 10px 16px; border-left: 3px solid var(--accent); background: var(--paper-inset); font-style: italic; color: var(--ink-soft); }
  .code-block { margin: 0 0 14px; background: var(--code-bg); border-radius: 8px; overflow: hidden; }
  .code-lang { font-family: 'JetBrains Mono', monospace; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--code-lang-text); background: var(--code-lang-bg); padding: 6px 14px; }
  .code-block pre { margin: 0; padding: 14px 16px; overflow-x: auto; }
  .code-block code { font-family: 'JetBrains Mono', monospace; font-size: 13px; color: var(--code-text); white-space: pre; }
  .artifact-card { display: flex; flex-direction: column; gap: 2px; margin: 0 0 14px; padding: 12px 16px; background: var(--paper-inset); border: 1px dashed var(--rule); border-radius: 6px; }
  .artifact-label { font-family: 'JetBrains Mono', monospace; font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent); }
  .artifact-title { font-weight: 600; font-size: 15px; }
  table { width: 100%; border-collapse: collapse; margin: 0 0 14px; font-size: 14px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--rule); }
  th { font-family: 'JetBrains Mono', monospace; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-soft); }
  footer { margin-top: 48px; font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--ink-soft); text-align: center; }
  @media print { body { background: white; color: black; } .turn { break-inside: avoid; } }
</style>
</head>
<body>
  <div class="page">
    <div class="title-block">
      <div class="eyebrow">Transcript</div>
      <h1 class="doc-title">${escapeHtml(conv.title)}</h1>
      <div class="meta">${conv.messages.length} messages \u00b7 exported ${escapeHtml(formatDate(conv.exportedAt))}</div>
      <div class="meta"><a href="${escapeHtml(conv.url)}">${escapeHtml(conv.url)}</a></div>
    </div>
    <div class="rule-double"></div>
    ${turns}
    <footer>Exported with Transcript \u2014 Export for Claude</footer>
  </div>
</body>
</html>`;
}

function toJSON(conv) {
  const withText = { ...conv, messages: conv.messages.map((m) => ({ ...m, text: m.blocks.map((b) => blockToMarkdown(b)).join('\n\n') })) };
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
// SIDEBAR UI  (Orange / Black-White theme with Dark Mode)
// =============================================================================

const SB_ID = 'transcript-export-sidebar';
const SB_TOGGLE_ID = 'transcript-export-toggle';
const SB_STYLE_ID = 'transcript-export-styles';
const THEME_KEY = 'transcript-theme';

function getStoredTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'light'; } catch (e) { return 'light'; }
}
function setStoredTheme(theme) {
  try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
}

function injectSidebarStyles() {
  if (document.getElementById(SB_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = SB_STYLE_ID;
  style.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');

    #${SB_ID} {
      --ts-bg: #FAFAF8;
      --ts-bg-inset: #F0EFEA;
      --ts-text: #111111;
      --ts-text-soft: #6B6B6B;
      --ts-border: #E5E5E0;
      --ts-accent: #E57035;
      --ts-accent-hover: #C55A28;
      --ts-accent-tint: #FFF1EB;
      --ts-user: #2563EB;
      --ts-claude: #059669;
      --ts-error: #DC2626;
      --ts-shadow: rgba(0,0,0,0.08);
      --ts-toggle-bg: #E57035;
      --ts-toggle-hover: #C55A28;
    }
    #${SB_ID}[data-theme="dark"] {
      --ts-bg: #111111;
      --ts-bg-inset: #1C1C1C;
      --ts-text: #FAFAF8;
      --ts-text-soft: #A0A0A0;
      --ts-border: #2A2A2A;
      --ts-accent: #F0885C;
      --ts-accent-hover: #D96A3A;
      --ts-accent-tint: #3D1F12;
      --ts-user: #60A5FA;
      --ts-claude: #34D399;
      --ts-error: #EF4444;
      --ts-shadow: rgba(0,0,0,0.35);
      --ts-toggle-bg: #F0885C;
      --ts-toggle-hover: #D96A3A;
    }

    #${SB_ID} {
      position: fixed;
      top: 0;
      right: -420px;
      width: 420px;
      height: 100vh;
      background: var(--ts-bg);
      border-left: 1px solid var(--ts-border);
      z-index: 2147483647;
      transition: right 0.35s cubic-bezier(0.4, 0, 0.2, 1);
      display: flex;
      flex-direction: column;
      font-family: 'Inter', sans-serif;
      color: var(--ts-text);
      box-shadow: -8px 0 40px var(--ts-shadow);
    }
    #${SB_ID}.open { right: 0; }
    #${SB_ID} * { box-sizing: border-box; }

    .ts-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 18px 20px 14px;
      border-bottom: 1px solid var(--ts-border);
      background: var(--ts-bg-inset);
      flex-shrink: 0;
      gap: 10px;
    }
    .ts-header-left { display: flex; align-items: center; gap: 12px; }
    .ts-header-title { font-weight: 700; font-size: 22px; letter-spacing: -0.02em; }
    .ts-header-actions { display: flex; align-items: center; gap: 6px; }
    .ts-header-btn {
      width: 32px; height: 32px; border-radius: 8px; border: 1px solid var(--ts-border);
      background: var(--ts-bg); color: var(--ts-text-soft); font-size: 16px;
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      line-height: 1; padding: 0; transition: all 0.15s ease;
    }
    .ts-header-btn:hover { background: var(--ts-border); color: var(--ts-text); }

    .ts-scroll {
      flex: 1; overflow-y: auto; padding: 16px 18px;
    }
    .ts-scroll::-webkit-scrollbar { width: 6px; }
    .ts-scroll::-webkit-scrollbar-thumb { background: var(--ts-border); border-radius: 3px; }

    .ts-section { margin-bottom: 22px; }
    .ts-section-title {
      font-family: 'JetBrains Mono', monospace; font-size: 10px; letter-spacing: 0.14em;
      text-transform: uppercase; color: var(--ts-accent); margin-bottom: 10px;
      display: flex; align-items: center; justify-content: space-between;
    }

    .ts-summary-list { display: flex; flex-direction: column; gap: 10px; }
    .ts-pair {
      background: var(--ts-bg-inset); border: 1px solid var(--ts-border);
      border-radius: 10px; padding: 12px 14px; font-size: 12.5px; line-height: 1.5;
    }
    .ts-pair-q, .ts-pair-a { display: flex; gap: 8px; }
    .ts-pair-q { margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px dashed var(--ts-border); }
    .ts-pair-label {
      font-family: 'JetBrains Mono', monospace; font-size: 9px; letter-spacing: 0.1em;
      text-transform: uppercase; font-weight: 600; flex-shrink: 0; margin-top: 2px;
    }
    .ts-pair-q .ts-pair-label { color: var(--ts-user); }
    .ts-pair-a .ts-pair-label { color: var(--ts-claude); }
    .ts-pair-text { color: var(--ts-text); display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
    .ts-pair-empty { color: var(--ts-text-soft); font-style: italic; text-align: center; padding: 20px; font-size: 12px; }

    .ts-formats { display: flex; flex-direction: column; gap: 8px; }
    .ts-format-btn {
      display: flex; align-items: stretch; gap: 10px; width: 100%; padding: 10px 12px;
      background: var(--ts-bg-inset); border: 1px solid var(--ts-border); border-radius: 8px;
      cursor: pointer; text-align: left; font-family: inherit;
      transition: transform 0.08s ease, border-color 0.15s ease, background 0.15s ease;
    }
    .ts-format-btn:hover { border-color: var(--ts-accent); background: var(--ts-accent-tint); transform: translateX(2px); }
    .ts-format-btn:active { transform: translateX(0); }
    .ts-format-rail { flex: 0 0 3px; border-radius: 2px; align-self: stretch; }
    .ts-format-rail.html { background: var(--ts-claude); }
    .ts-format-rail.md { background: var(--ts-user); }
    .ts-format-rail.json { background: var(--ts-accent); }
    .ts-format-rail.pdf { background: var(--ts-error); }
    .ts-format-name { font-weight: 600; font-size: 14px; }
    .ts-format-desc { font-size: 11px; color: var(--ts-text-soft); }

    .ts-status { min-height: 16px; font-family: 'JetBrains Mono', monospace; font-size: 11px; line-height: 1.5; margin-top: 4px; }
    .ts-status.pending { color: var(--ts-text-soft); }
    .ts-status.success { color: var(--ts-claude); }
    .ts-status.error { color: var(--ts-error); }

    .ts-footer { font-size: 10px; color: var(--ts-text-soft); text-align: center; padding: 10px 0 4px; }
    .ts-refresh-btn { background: none; border: none; color: var(--ts-accent); cursor: pointer; font-size: 14px; padding: 2px 6px; border-radius: 4px; line-height: 1; }
    .ts-refresh-btn:hover { background: var(--ts-border); }

    #${SB_TOGGLE_ID} {
      position: fixed; bottom: 24px; right: 24px; width: 52px; height: 52px;
      border-radius: 50%; background: var(--ts-toggle-bg); color: #fff; border: none;
      cursor: pointer; z-index: 2147483646; box-shadow: 0 4px 16px rgba(0,0,0,0.25);
      font-size: 22px; display: flex; align-items: center; justify-content: center;
      transition: transform 0.2s ease, background 0.2s ease; font-family: 'Inter', sans-serif; padding: 0;
    }
    #${SB_TOGGLE_ID}:hover { transform: scale(1.08); background: var(--ts-toggle-hover); }
    #${SB_TOGGLE_ID}:active { transform: scale(0.96); }
    #${SB_TOGGLE_ID}.hidden { display: none !important; }
  `;
  document.head.appendChild(style);
}

function createSidebar() {
  if (document.getElementById(SB_ID)) return;
  const sidebar = document.createElement('div');
  sidebar.id = SB_ID;
  sidebar.setAttribute('data-theme', getStoredTheme());
  sidebar.innerHTML = `
    <div class="ts-header">
      <div class="ts-header-left">
        <div class="ts-header-title">Transcript</div>
      </div>
      <div class="ts-header-actions">
        <button class="ts-header-btn" id="ts-theme-toggle" title="Toggle dark mode">\u2600</button>
        <button class="ts-header-btn" id="ts-close" title="Close sidebar">\u00d7</button>
      </div>
    </div>
    <div class="ts-scroll">
      <div class="ts-section">
        <div class="ts-section-title">
          <span>Conversation Summary</span>
          <button class="ts-refresh-btn" id="ts-refresh" title="Refresh summary">\u21bb</button>
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
            <span><div class="ts-format-name">Styled HTML</div><div class="ts-format-desc">Manuscript layout, ready to print or share</div></span>
          </button>
          <button class="ts-format-btn" data-format="markdown">
            <span class="ts-format-rail md"></span>
            <span><div class="ts-format-name">Markdown</div><div class="ts-format-desc">Clean .md for notes apps &amp; repos</div></span>
          </button>
          <button class="ts-format-btn" data-format="json">
            <span class="ts-format-rail json"></span>
            <span><div class="ts-format-name">JSON</div><div class="ts-format-desc">Structured data for your own tooling</div></span>
          </button>
          <button class="ts-format-btn" data-format="pdf">
            <span class="ts-format-rail pdf"></span>
            <span><div class="ts-format-name">PDF</div><div class="ts-format-desc">Print-ready document via your browser</div></span>
          </button>
        </div>
      </div>
      <div id="ts-status" class="ts-status"></div>
      <div class="ts-footer">Runs entirely in your browser \u2014 nothing leaves the page.</div>
    </div>
  `;
  document.body.appendChild(sidebar);

  sidebar.querySelector('#ts-close').addEventListener('click', (e) => { e.stopPropagation(); toggleSidebar(); });
  sidebar.querySelector('#ts-theme-toggle').addEventListener('click', (e) => { e.stopPropagation(); toggleTheme(); });
  sidebar.querySelectorAll('.ts-format-btn').forEach((btn) => { btn.addEventListener('click', (e) => { e.stopPropagation(); doExport(btn.dataset.format); }); });
  sidebar.querySelector('#ts-refresh').addEventListener('click', (e) => { e.stopPropagation(); refreshSummary(); });
  updateThemeIcon();
}

function createToggle() {
  if (document.getElementById(SB_TOGGLE_ID)) return;
  const btn = document.createElement('button');
  btn.id = SB_TOGGLE_ID;
  btn.innerHTML = '\u{1F4C4}';
  btn.title = 'Toggle Transcript sidebar';
  btn.addEventListener('click', (e) => { e.stopPropagation(); toggleSidebar(); });
  document.body.appendChild(btn);
}

function toggleSidebar() {
  const sb = document.getElementById(SB_ID);
  if (!sb) { initSidebar(); setTimeout(() => { document.getElementById(SB_ID)?.classList.add('open'); refreshSummary(); }, 50); return; }
  sb.classList.toggle('open');
  if (sb.classList.contains('open')) refreshSummary();
}

function toggleTheme() {
  const sb = document.getElementById(SB_ID);
  if (!sb) return;
  const current = sb.getAttribute('data-theme') || 'light';
  const next = current === 'light' ? 'dark' : 'light';
  sb.setAttribute('data-theme', next);
  setStoredTheme(next);
  updateThemeIcon();
}

function updateThemeIcon() {
  const btn = document.getElementById('ts-theme-toggle');
  const sb = document.getElementById(SB_ID);
  if (!btn || !sb) return;
  const theme = sb.getAttribute('data-theme') || 'light';
  btn.textContent = theme === 'light' ? '\u263d' : '\u2600';
  btn.title = theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode';
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
    if (b.type === 'paragraph' || b.type === 'heading') texts.push(b.text);
    else if (b.type === 'list' && b.items.length) texts.push('\u2022 ' + b.items[0]);
    else if (b.type === 'code') texts.push('`code`');
    if (texts.join(' ').length > maxLen) return texts.join(' ').slice(0, maxLen) + '\u2026';
  }
  return texts.join(' ').trim() || '(empty)';
}

function buildSummary(conv) {
  const pairs = []; let current = null;
  for (const msg of conv.messages) {
    if (msg.role === 'user') { if (current) pairs.push(current); current = { question: getMessagePreview(msg.blocks, 160), answer: '' }; }
    else if (msg.role === 'assistant' && current) { current.answer = getMessagePreview(msg.blocks, 260); }
  }
  if (current) pairs.push(current);
  return pairs;
}

function renderSummary(pairs) {
  const container = document.getElementById('ts-summary');
  if (!container) return;
  if (!pairs.length) { container.innerHTML = '<div class="ts-pair-empty">No messages found. Open a conversation with at least one reply.</div>'; return; }
  container.innerHTML = pairs.map((p, i) => `
    <div class="ts-pair">
      <div class="ts-pair-q"><span class="ts-pair-label">Q${i + 1}</span><span class="ts-pair-text">${escapeHtml(p.question)}</span></div>
      <div class="ts-pair-a"><span class="ts-pair-label">A${i + 1}</span><span class="ts-pair-text">${escapeHtml(p.answer || '\u2026')}</span></div>
    </div>
  `).join('');
}

function refreshSummary() {
  try { const conv = extractConversation(); renderSummary(buildSummary(conv)); }
  catch (e) { renderSummary([]); }
}

async function doExport(format) {
  setStatus('Reading conversation\u2026', 'pending');
  try {
    const conv = extractConversation();
    if (!conv.messages.length) { setStatus('No messages found. Open a conversation first.', 'error'); return; }
    let content, mime, ext;
    if (format === 'markdown') { content = toMarkdown(conv); mime = 'text/markdown'; ext = 'md'; }
    else if (format === 'html') { content = toHTML(conv); mime = 'text/html'; ext = 'html'; }
    else if (format === 'json') { content = toJSON(conv); mime = 'application/json'; ext = 'json'; }
    else if (format === 'pdf') {
      content = toHTML(conv);
      const blob = new Blob([content], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const win = window.open(url, '_blank');
      const tryPrint = () => { if (win && win.document && win.document.readyState === 'complete') { win.print(); setTimeout(() => URL.revokeObjectURL(url), 60000); } else { setTimeout(tryPrint, 300); } };
      setTimeout(tryPrint, 500);
      setStatus(`Opened ${conv.messages.length} messages in print view \u2014 choose "Save as PDF"`, 'success');
      return;
    } else { setStatus('Unknown format.', 'error'); return; }
    const filename = `${slugify(conv.title)}-transcript.${ext}`;
    downloadFile(filename, content, mime);
    setStatus(`Saved ${conv.messages.length} messages \u2192 ${filename}`, 'success');
  } catch (e) { setStatus(`Export failed: ${e.message}`, 'error'); }
}

function initSidebar() {
  injectSidebarStyles();
  createSidebar();
  createToggle();
}

if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', initSidebar); }
else { initSidebar(); }

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'TOGGLE_SIDEBAR') { toggleSidebar(); sendResponse({ success: true }); return; }
  if (!msg || msg.type !== 'EXPORT') return;
  try {
    const conv = extractConversation();
    if (!conv.messages.length) { sendResponse({ success: false, error: 'no_messages' }); return; }
    let content, mime, ext;
    if (msg.format === 'markdown') { content = toMarkdown(conv); mime = 'text/markdown'; ext = 'md'; }
    else if (msg.format === 'html') { content = toHTML(conv); mime = 'text/html'; ext = 'html'; }
    else if (msg.format === 'json') { content = toJSON(conv); mime = 'application/json'; ext = 'json'; }
    else if (msg.format === 'pdf') {
      content = toHTML(conv);
      const blob = new Blob([content], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const win = window.open(url, '_blank');
      const tryPrint = () => { if (win && win.document && win.document.readyState === 'complete') { win.print(); setTimeout(() => URL.revokeObjectURL(url), 60000); } else { setTimeout(tryPrint, 300); } };
      setTimeout(tryPrint, 500);
      sendResponse({ success: true, count: conv.messages.length, filename: 'print-view.html' });
      return;
    } else { sendResponse({ success: false, error: 'Unknown format' }); return; }
    const filename = `${slugify(conv.title)}-transcript.${ext}`;
    downloadFile(filename, content, mime);
    sendResponse({ success: true, count: conv.messages.length, filename });
  } catch (e) { sendResponse({ success: false, error: e.message }); }
});
