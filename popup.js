// Global state in popup
let allItems = [];
let filteredItems = [];
let acquiring = false;
let activePlatform = 'instagram';

// Date utility functions
const dayStart = (d) =>
  d ? Math.floor(new Date(`${d}T00:00:00`).getTime() / 1000) : null;
const dayEnd = (d) =>
  d ? Math.floor(new Date(`${d}T23:59:59.999`).getTime() / 1000) : null;

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function showNotice(msg, isError = false) {
  const notice = document.getElementById('notice');
  if (!notice) return;
  notice.textContent = msg;
  if (isError) {
    notice.classList.add('error');
  } else {
    notice.classList.remove('error');
  }
}

function updateStats() {
  const totalEl = document.getElementById('stat-total');
  if (totalEl) totalEl.textContent = allItems.length;
}

function applyFilters() {
  let list = [...allItems];

  // Sort descending by timestamp
  list.sort((a, b) => (b.taken_at_timestamp || 0) - (a.taken_at_timestamp || 0));

  // Date Range filter
  const chkDate = document.getElementById('chk-date');
  if (chkDate && chkDate.checked) {
    const fromVal = document.getElementById('val-date-from').value;
    const toVal = document.getElementById('val-date-to').value;
    const fromTime = dayStart(fromVal);
    const toTime = dayEnd(toVal);

    list = list.filter(item => {
      const stamp = item.taken_at_timestamp;
      if (!stamp) return false;
      if (fromTime !== null && stamp < fromTime) return false;
      if (toTime !== null && stamp > toTime) return false;
      return true;
    });
  }

  // Limit Filter
  const chkNewest = document.getElementById('chk-newest');
  if (chkNewest && chkNewest.checked) {
    const limit = Number(document.getElementById('val-newest').value) || 0;
    if (limit > 0) {
      list = list.slice(0, limit);
    }
  }

  filteredItems = list;
  
  const selectedEl = document.getElementById('stat-selected');
  if (selectedEl) selectedEl.textContent = filteredItems.length;

  const statusText = document.getElementById('status-text');
  if (statusText) statusText.textContent = `Ready: ${filteredItems.length} items selected`;
}

function syncItemsFromStorage() {
  chrome.storage.local.get("socialBulkItems").then((r) => {
    const rawItems = r.socialBulkItems || [];
    allItems = rawItems.filter(item => item.platform === activePlatform);
    updateStats();
    applyFilters();
  });
}

function updateAcquireButton() {
  const btnToggle = document.getElementById('btn-toggle-acquire');
  if (!btnToggle) return;
  if (acquiring) {
    btnToggle.textContent = "⏹ Stop Acquiring";
    btnToggle.classList.add("stop-active");
  } else {
    btnToggle.textContent = "▶ Start Acquiring";
    btnToggle.classList.remove("stop-active");
  }
}

async function initPlatformContext() {
  const tab = await getActiveTab();
  const badge = document.getElementById('platform-badge');
  const nameSpan = document.getElementById('platform-name');
  const btnToggle = document.getElementById('btn-toggle-acquire');

  if (tab && tab.url) {
    if (tab.url.includes("instagram.com")) {
      activePlatform = 'instagram';
      if (badge) badge.className = "platform-badge badge-instagram";
      if (nameSpan) nameSpan.textContent = "Instagram";
      if (btnToggle) btnToggle.disabled = false;
      showNotice("Ready to harvest Instagram reels & videos.");
    } else if (tab.url.includes("tiktok.com")) {
      activePlatform = 'tiktok';
      if (badge) badge.className = "platform-badge badge-tiktok";
      if (nameSpan) nameSpan.textContent = "TikTok";
      if (btnToggle) btnToggle.disabled = false;
      showNotice("Ready to harvest TikTok profile videos.");
    } else {
      activePlatform = 'unknown';
      if (badge) badge.className = "platform-badge";
      if (nameSpan) nameSpan.textContent = "Unsupported Page";
      if (btnToggle) btnToggle.disabled = true;
      showNotice("Open Instagram or TikTok in active tab first.", true);
    }
  } else {
    activePlatform = 'unknown';
    if (badge) badge.className = "platform-badge";
    if (nameSpan) nameSpan.textContent = "No Tab Found";
    if (btnToggle) btnToggle.disabled = true;
    showNotice("No active webpage tab detected.", true);
  }

  // Restore current tab status if script is running
  if (tab && tab.id && activePlatform !== 'unknown') {
    chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' }).then(res => {
      if (res) {
        acquiring = res.isAcquiring;
        updateAcquireButton();
      }
    }).catch(() => {});
  }

  syncItemsFromStorage();
}

// Dom listeners setup
document.addEventListener('DOMContentLoaded', () => {
  initPlatformContext();

  const btnToggle = document.getElementById('btn-toggle-acquire');
  if (btnToggle) {
    btnToggle.onclick = async () => {
      const tab = await getActiveTab();
      if (!tab || activePlatform === 'unknown') {
        showNotice("Open Instagram or TikTok to run acquisition.", true);
        return;
      }

      if (acquiring) {
        chrome.tabs.sendMessage(tab.id, { type: "INSTABULK_STOP" }).catch(() => {});
        acquiring = false;
        updateAcquireButton();
        showNotice("Acquisition stopped by user.");
      } else {
        // RESET: Clear popup state for a fresh run
        allItems = [];
        filteredItems = [];
        updateStats();
        applyFilters();

        const newestLimit = document.getElementById('chk-newest').checked ? Number(document.getElementById('val-newest').value) || 0 : 0;
        const fromTs = document.getElementById('chk-date').checked ? dayStart(document.getElementById('val-date-from').value) : null;
        const toTs = document.getElementById('chk-date').checked ? dayEnd(document.getElementById('val-date-to').value) : null;

        // content.js handles the full session reset (clearing storage, map, profile handle)
        chrome.tabs.sendMessage(tab.id, {
          type: "INSTABULK_ACQUIRE",
          newestLimit,
          fromTs,
          toTs
        }).then(res => {
          if (res && res.ok) {
            acquiring = true;
            updateAcquireButton();
            showNotice("🟢 Harvesting active! Scrolling and parsing network data...");
          }
        }).catch(() => {
          showNotice("Failed to launch harvester. Refresh the page and try again.", true);
        });
      }
    };
  }

  // Interlocked checkboxes
  const chkNewest = document.getElementById('chk-newest');
  const chkDate = document.getElementById('chk-date');
  if (chkNewest && chkDate) {
    chkNewest.addEventListener('change', () => {
      if (chkNewest.checked) {
        chkDate.checked = false;
        applyFilters();
      }
    });
    chkDate.addEventListener('change', () => {
      if (chkDate.checked) {
        chkNewest.checked = false;
        applyFilters();
      }
    });
  }

  // Auto-filtering listeners
  const filterIds = ['chk-newest', 'val-newest', 'chk-date', 'val-date-from', 'val-date-to'];
  filterIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', applyFilters);
      el.addEventListener('change', applyFilters);
    }
  });

  // Action Buttons
  const btnExport = document.getElementById('btn-export');
  if (btnExport) {
    btnExport.onclick = () => {
      if (filteredItems.length === 0) {
        showNotice("No items to export.", true);
        return;
      }
      const blob = new Blob([JSON.stringify(filteredItems, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `SocialBulk_export_${activePlatform}_${Date.now()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      showNotice(`Exported ${filteredItems.length} records.`);
    };
  }

  const btnFolder = document.getElementById('btn-folder');
  if (btnFolder) {
    btnFolder.onclick = () => {
      if (filteredItems.length === 0) {
        showNotice("No items selected for download.", true);
        return;
      }
      chrome.runtime.sendMessage({
        type: 'START_DOWNLOAD',
        platform: activePlatform,
        items: filteredItems,
        downloadType: 'folder'
      });
      window.close();
    };
  }

  const btnZip = document.getElementById('btn-zip');
  if (btnZip) {
    btnZip.onclick = () => {
      if (filteredItems.length === 0) {
        showNotice("No items selected for ZIP bundle.", true);
        return;
      }
      chrome.runtime.sendMessage({
        type: 'START_DOWNLOAD',
        platform: activePlatform,
        items: filteredItems,
        downloadType: 'zip'
      });
      window.close();
    };
  }
});

// Runtime messages receiver
chrome.runtime.onMessage.addListener((m) => {
  if (m.type === "INSTABULK_ITEM") {
    syncItemsFromStorage();
  }
  if (m.type === "INSTABULK_AUTO_STOP") {
    if (m.platform === activePlatform) {
      acquiring = false;
      updateAcquireButton();
      showNotice(m.note || "Finished acquisition.");
    }
  }
});
