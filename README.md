# Transcript — Export for Claude

A Chrome extension that exports your current Claude.ai conversation as a
nicely formatted file: styled HTML (manuscript-style transcript), clean
Markdown, or structured JSON. Everything runs locally in your browser —
no API key, no server, no data leaving the page.

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
2. Click the Transcript icon in your toolbar.
3. Pick a format:
   - **Styled HTML** — a designed, print-ready transcript with speaker rails,
     styled code blocks, and artifact callouts. Best for sharing or archiving.
   - **Markdown** — clean `.md`, good for Obsidian/Notion/repos.
   - **JSON** — structured `{role, blocks, text}` data for your own tooling.
4. The file downloads straight to your Downloads folder.

## How it works

- `content.js` runs on `claude.ai` pages. When you click a format button, it
  walks the DOM of the open conversation, turns each turn into structured
  blocks (paragraphs, headings, lists, code blocks, quotes, tables, and
  artifact callouts), and renders that structure into the chosen format.
- `popup.html/js/css` is just the toolbar UI — it asks the content script to
  do the export and reports back success/failure.
- Nothing is sent over the network. The extension only needs `activeTab` and
  access to `claude.ai`.

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
