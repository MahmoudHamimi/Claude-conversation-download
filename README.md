# Transcript — Export for Claude (Sidebar Edition)

A Chrome extension that exports your current Claude.ai conversation as a
nicely formatted file: styled HTML (manuscript-style transcript), clean
Markdown, structured JSON, or print-ready PDF. 

**New in this version:**
- **Sidebar UI** — No more popup window. A sleek sidebar slides in from the right side of Claude.ai itself, plus a floating toggle button.
- **Conversation Summary** — See every Q&A pair at a glance. Each question is paired with its answer, numbered for easy reference.
- **PDF Export** — Opens the styled transcript in a print view so you can save as PDF straight from your browser.

Everything runs locally in your browser — no API key, no server, no data leaving the page.

## Install (unpacked / developer mode)

1. Unzip this folder somewhere permanent (don't delete it after installing —
   Chrome loads the extension directly from these files).
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the unzipped `claude-transcript-export`
   folder.
5. Pin the extension (puzzle-piece icon in the toolbar → pin "Transcript").

## Use

1. Open any conversation on `claude.ai`.
2. A floating 📄 button appears in the bottom-right corner. Click it (or click the Transcript toolbar icon) to open the sidebar.
3. The sidebar shows a **Conversation Summary** with every Q&A pair, plus **Export** buttons:
   - **Styled HTML** — a designed, print-ready transcript with speaker rails,
     styled code blocks, and artifact callouts. Best for sharing or archiving.
   - **Markdown** — clean `.md`, good for Obsidian/Notion/repos.
   - **JSON** — structured `{role, blocks, text}` data for your own tooling.
   - **PDF** — opens the styled HTML in a new tab and triggers the print dialog. Choose "Save as PDF" as the destination.
4. Files download straight to your Downloads folder (HTML/Markdown/JSON) or open in a print tab (PDF).

## How it works

- `content.js` runs on `claude.ai` pages. It injects the sidebar UI and the floating toggle button directly into the page.
- When you click an export button, it walks the DOM of the open conversation, turns each turn into structured blocks (paragraphs, headings, lists, code blocks, quotes, tables, and artifact callouts), and renders that structure into the chosen format.
- `background.js` handles clicks on the extension toolbar icon to toggle the sidebar.
- Nothing is sent over the network. The extension only needs `activeTab` and access to `claude.ai`.

## If exports come up empty

Claude.ai's DOM structure can change with product updates. If "No messages
found" shows up, the CSS selectors in `content.js` (`USER_SELECTORS` /
`ASSISTANT_SELECTORS` near the top of the file) likely need updating to match
the current page structure — right-click a message on claude.ai → Inspect,
and look at the class names or `data-testid` attributes on the container.

## Notes

- Artifacts (code/React/HTML artifacts Claude generates) are captured as a
  labeled callout with their title rather than their full rendered content,
  since they render in a separate panel outside the normal message flow.
- Very long conversations export fine, but the styled HTML file embeds
  Google Fonts via a CDN link, so an internet connection is needed to see
  the intended fonts when opening the exported file (it still degrades
  gracefully to system fonts offline).
- The sidebar summary shows truncated previews (first ~160 chars of the question, ~260 of the answer). Click the refresh button (↻) to update if you navigate to a different conversation.
