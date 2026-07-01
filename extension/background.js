// background.js — Service Worker for 公众号漫画阅读器
// Responsibilities:
//   1. Listen for toolbar icon clicks
//   2. Forward toggle message to content script
//   3. Fallback: if content script not injected (tab opened before extension install),
//      show orange badge to prompt user to refresh

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.url?.includes('mp.weixin.qq.com/s')) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'toggle' });
  } catch {
    // Content script not ready — likely a tab opened before extension install.
    // Show badge hint to refresh.
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#FFA500' });
    setTimeout(() => {
      chrome.action.setBadgeText({ text: '' });
    }, 3000);
  }
});
