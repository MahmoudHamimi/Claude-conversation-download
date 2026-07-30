chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.url?.startsWith('https://claude.ai')) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR' });
    } catch (e) {
      // Content script may not be injected yet; nothing to do.
    }
  } else {
    chrome.tabs.create({ url: 'https://claude.ai' });
  }
});
