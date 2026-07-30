const statusEl = document.getElementById('status');

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (kind ? ` ${kind}` : '');
}

async function doExport(format) {
  setStatus('Reading conversation…', 'pending');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.startsWith('https://claude.ai')) {
    setStatus('Open a Claude.ai conversation first.', 'error');
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: 'EXPORT', format }, (response) => {
    if (chrome.runtime.lastError) {
      setStatus('Reload the Claude.ai tab and try again.', 'error');
      return;
    }
    if (!response) {
      setStatus('No response — try reloading the page.', 'error');
      return;
    }
    if (!response.success) {
      if (response.error === 'no_messages') {
        setStatus('No messages found. Open a conversation with at least one reply.', 'error');
      } else {
        setStatus(`Export failed: ${response.error}`, 'error');
      }
      return;
    }
    setStatus(`Saved ${response.count} messages → ${response.filename}`, 'success');
  });
}

document.querySelectorAll('.format-btn').forEach((btn) => {
  btn.addEventListener('click', () => doExport(btn.dataset.format));
});
