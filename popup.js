document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('popup-enable');
  if (!toggle) return;

  function isContextValid() {
    try {
      return typeof chrome !== 'undefined' && Boolean(chrome.runtime && (chrome.runtime.id !== undefined || !('id' in chrome.runtime)));
    } catch (e) {
      return false;
    }
  }

  if (isContextValid() && chrome.storage && chrome.storage.sync) {
    try {
      chrome.storage.sync.get(['nds_enabled'], (res) => {
        try {
          if (isContextValid() && res && res.nds_enabled !== undefined) {
            toggle.checked = res.nds_enabled;
          }
        } catch (e) {}
      });
    } catch (e) {}
  }

  toggle.addEventListener('change', (e) => {
    try {
      const enabled = e.target.checked;
      if (isContextValid() && chrome.storage && chrome.storage.sync) {
        chrome.storage.sync.set({ nds_enabled: enabled }, () => {
          if (chrome.runtime && chrome.runtime.lastError) {}
        });
      }
    } catch (err) {}
  });
});
