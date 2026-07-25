importScripts('jszip.min.js');

console.log("SocialBulk Pro Service Worker loaded");

let activeQueue = [];
let abortDownload = false;
let activeDownloadId = null;
let currentAbortController = null;
let currentPlatform = 'instagram';
let currentDownloadType = 'folder';

/**
 * Validates that a URL is a downloadable media stream, NOT an HTML page link.
 * Rejects page navigation links like instagram.com/reel/ or tiktok.com/@user/
 */
function isDownloadableUrl(url) {
  if (!url || typeof url !== 'string') return false;
  // Reject page navigation links
  if (/^https?:\/\/(www\.)?instagram\.com\/(reel|p|tv)\//i.test(url)) return false;
  if (/^https?:\/\/(www\.)?tiktok\.com\/@/i.test(url)) return false;
  // Accept data URLs (already pre-fetched blobs)
  if (url.startsWith('data:')) return true;
  // Accept CDN domains
  if (url.includes('cdninstagram.com')) return true;
  if (url.includes('fbcdn.net')) return true;
  if (url.includes('scontent')) return true;
  if (url.includes('tiktokcdn.com')) return true;
  if (url.includes('tiktokcdn-us.com')) return true;
  if (url.includes('tikwm.com')) return true;
  if (/\.mp4/i.test(url)) return true;
  if (url.includes('video/tos/')) return true;
  return false;
}

/* ──────────────────────────────────────────────────────────────────────────────
 *  declarativeNetRequest – Strip Origin & Spoof Referer on CDN requests
 *  This is the core CORS bypass.  Instagram/TikTok CDN servers reject fetches
 *  that arrive with an `Origin: chrome-extension://…` header.  By removing
 *  Origin and setting a first-party Referer the CDN treats the request as if
 *  it came from the website itself.
 * ──────────────────────────────────────────────────────────────────────────── */
async function installHeaderRules() {
  // Remove any stale rules from a prior install
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const existingIds = existing.map(r => r.id);
  if (existingIds.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existingIds });
  }

  const rules = [
    // ── Instagram / Facebook CDN ──────────────────────────────────────────
    {
      id: 1,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Origin",  operation: "remove" },
          { header: "Referer", operation: "set", value: "https://www.instagram.com/" }
        ]
      },
      condition: {
        urlFilter: "||fbcdn.net",
        resourceTypes: ["xmlhttprequest", "other"]
      }
    },
    {
      id: 2,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Origin",  operation: "remove" },
          { header: "Referer", operation: "set", value: "https://www.instagram.com/" }
        ]
      },
      condition: {
        urlFilter: "||cdninstagram.com",
        resourceTypes: ["xmlhttprequest", "other"]
      }
    },
    {
      id: 3,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Origin",  operation: "remove" },
          { header: "Referer", operation: "set", value: "https://www.instagram.com/" }
        ]
      },
      condition: {
        urlFilter: "||instagram.com/api/",
        resourceTypes: ["xmlhttprequest", "other"]
      }
    },
    // ── TikTok CDN ────────────────────────────────────────────────────────
    {
      id: 4,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Origin",  operation: "remove" },
          { header: "Referer", operation: "set", value: "https://www.tiktok.com/" }
        ]
      },
      condition: {
        urlFilter: "||tiktokcdn.com",
        resourceTypes: ["xmlhttprequest", "other"]
      }
    },
    {
      id: 5,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Origin",  operation: "remove" },
          { header: "Referer", operation: "set", value: "https://www.tiktok.com/" }
        ]
      },
      condition: {
        urlFilter: "||tiktokcdn-us.com",
        resourceTypes: ["xmlhttprequest", "other"]
      }
    },
    // ── TikWM API ─────────────────────────────────────────────────────────
    {
      id: 6,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Origin",  operation: "remove" },
          { header: "Referer", operation: "set", value: "https://www.tikwm.com/" }
        ]
      },
      condition: {
        urlFilter: "||tikwm.com",
        resourceTypes: ["xmlhttprequest", "other"]
      }
    }
  ];

  await chrome.declarativeNetRequest.updateDynamicRules({ addRules: rules });
  console.log("✅ declarativeNetRequest header-modification rules installed");
}

// Install rules on service-worker boot
installHeaderRules();

/* ──────────────────────────────────────────────────────────────────────────────
 *  Persist download state & broadcast progress to content scripts
 * ──────────────────────────────────────────────────────────────────────────── */
async function saveDownloadState(state) {
  await chrome.storage.local.set({ downloadState: state });
  updateBadge(state);

  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id && tab.url && (tab.url.includes("instagram.com") || tab.url.includes("tiktok.com"))) {
        chrome.tabs.sendMessage(tab.id, {
          type: 'INSTABULK_DOWNLOAD_PROGRESS',
          ...state
        }).catch(() => {});
      }
    }
  } catch (err) {
    console.warn("Failed to query tabs for progress broadcast:", err);
  }
}

function updateBadge(state) {
  if (state && state.isDownloading && state.total > 0) {
    chrome.action.setBadgeText({ text: `${state.current}/${state.total}` });
    chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

/* ──────────────────────────────────────────────────────────────────────────────
 *  Blob helpers
 * ──────────────────────────────────────────────────────────────────────────── */
function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("FileReader failed"));
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

/* ──────────────────────────────────────────────────────────────────────────────
 *  Robust fetch with multiple fallback strategies
 *  Strategy 1: Direct background fetch (works once declarativeNetRequest
 *              strips Origin / spoofs Referer).
 *  Strategy 2: If strategy 1 throws a DOMException (opaque/CORS block),
 *              delegate the fetch to the content script in the active tab
 *              where the page's own cookies/origin context pass CDN checks,
 *              then transfer the result back as a Base64 data-URL.
 * ──────────────────────────────────────────────────────────────────────────── */
async function robustFetchBlob(url, signal) {
  // Strategy 1 – direct fetch from service worker
  try {
    const res = await fetch(url, {
      signal,
      credentials: 'omit',
      mode: 'cors',
      headers: {
        'Accept': '*/*'
      }
    });
    if (res.ok) {
      const blob = await res.blob();
      if (blob.size > 0) return blob;
    }
    // Non-ok but no exception → fall through to strategy 2
  } catch (directErr) {
    console.warn("Direct fetch failed, trying content-script relay:", directErr.message || directErr);
  }

  // Strategy 2 – relay fetch through active tab's content script
  try {
    const tabs = await chrome.tabs.query({});
    const targetTab = tabs.find(t =>
      t.id && t.url && (t.url.includes("instagram.com") || t.url.includes("tiktok.com"))
    );
    if (targetTab) {
      const results = await chrome.scripting.executeScript({
        target: { tabId: targetTab.id },
        func: async (mediaUrl) => {
          try {
            const r = await fetch(mediaUrl, { credentials: 'include' });
            if (!r.ok) return null;
            const blob = await r.blob();
            return new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = () => reject("FileReader failed in tab");
              reader.readAsDataURL(blob);
            });
          } catch (e) {
            return null;
          }
        },
        args: [url],
        world: 'MAIN'
      });

      if (results && results[0] && results[0].result) {
        // Convert Data URL back to Blob
        const dataUrl = results[0].result;
        const resp = await fetch(dataUrl);
        return await resp.blob();
      }
    }
  } catch (relayErr) {
    console.warn("Content-script relay fetch also failed:", relayErr.message || relayErr);
  }

  // Strategy 3 – last resort: no-cors opaque fetch (for chrome.downloads only)
  try {
    const res = await fetch(url, { signal, mode: 'no-cors', credentials: 'omit' });
    const blob = await res.blob();
    if (blob.size > 0) return blob;
  } catch (_) {}

  return null;
}

/* ──────────────────────────────────────────────────────────────────────────────
 *  TikTok stream resolver via TikWM API
 * ──────────────────────────────────────────────────────────────────────────── */
async function resolveTiktokStream(v) {
  const rawId = String(v.id).replace(/[^0-9]/g, '');
  const pageUrl = (v.url && v.url.includes('http')) ? v.url : `https://www.tiktok.com/@user/video/${rawId}`;

  try {
    const res = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(pageUrl)}`);
    const json = await res.json();
    if (json && json.data) {
      return json.data.hdplay || json.data.play || json.data.wmplay || pageUrl;
    }
  } catch (e) {
    console.warn("TikWM resolve attempt failed:", e);
  }
  return v.url || pageUrl;
}

/**
 * Resolves a media item URL to a direct downloadable stream.
 * For Instagram: if the URL is a page link, tries to extract CDN URL via
 *   content script relay (executeScript in the tab context).
 * For TikTok: uses TikWM API.
 * Returns a direct CDN URL or null if unresolvable.
 */
async function resolveMediaUrl(item, platform) {
  let url = item.url;

  // Already a downloadable CDN URL
  if (isDownloadableUrl(url)) return url;

  // TikTok: resolve via TikWM
  if (platform === 'tiktok') {
    url = await resolveTiktokStream(item);
    if (isDownloadableUrl(url)) return url;
  }

  // Instagram page link fallback: try to resolve via content script in active tab
  if (platform === 'instagram' && url && url.includes('instagram.com')) {
    try {
      const tabs = await chrome.tabs.query({});
      const igTab = tabs.find(t => t.id && t.url && t.url.includes('instagram.com'));
      if (igTab) {
        const results = await chrome.scripting.executeScript({
          target: { tabId: igTab.id },
          func: async (pageUrl) => {
            try {
              const resp = await fetch(pageUrl, { credentials: 'include' });
              const html = await resp.text();
              // Extract video CDN URL from the page HTML
              const cdnMatch = html.match(/"video_url"\s*:\s*"([^"]+)"/)
                || html.match(/"playback_url"\s*:\s*"([^"]+)"/)
                || html.match(/"src"\s*:\s*"(https:\/\/[^"]*scontent[^"]*\.mp4[^"]*)"/)
                || html.match(/"src"\s*:\s*"(https:\/\/[^"]*cdninstagram[^"]*)"/)
                || html.match(/"src"\s*:\s*"(https:\/\/[^"]*fbcdn\.net[^"]*)"/i);
              if (cdnMatch && cdnMatch[1]) {
                return cdnMatch[1].replace(/\\u0026/g, '&').replace(/\\\/\//g, '//');
              }
              return null;
            } catch (e) {
              return null;
            }
          },
          args: [url],
          world: 'MAIN'
        });

        if (results && results[0] && results[0].result) {
          return results[0].result;
        }
      }
    } catch (err) {
      console.warn('Instagram page-link resolution failed:', err);
    }
  }

  // If nothing worked, return whatever we have — robustFetchBlob may still handle it
  return url;
}

/* ──────────────────────────────────────────────────────────────────────────────
 *  Sequential folder downloader
 * ──────────────────────────────────────────────────────────────────────────── */
async function runFolderDownload(items, platform) {
  const total = items.length;
  for (let i = 0; i < total; i++) {
    if (abortDownload) return;

    const item = items[i];
    try {
      let resolvedUrl = await resolveMediaUrl(item, platform);
      if (!resolvedUrl) {
        console.warn(`Skipping item ${item.id}: could not resolve to a downloadable URL`);
        continue;
      }

      currentAbortController = new AbortController();
      let downloadUrl = resolvedUrl;

      // Try to pre-fetch as blob → base64 data URL for reliable chrome.downloads
      const blob = await robustFetchBlob(resolvedUrl, currentAbortController.signal);
      if (blob && blob.size > 0) {
        downloadUrl = await blobToDataURL(blob);
      }

      if (abortDownload) return;

      const cleanTitle = (item.title || 'media_item')
        .slice(0, 50)
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .replace(/_+/g, '_');
      const platformFolder = platform === 'tiktok' ? 'TikTok' : 'Instagram';
      const filename = `SocialBulk/${platformFolder}/${item.id}_${cleanTitle}.mp4`;

      await new Promise((resolve, reject) => {
        chrome.downloads.download({
          url: downloadUrl,
          filename: filename,
          conflictAction: "uniquify",
          saveAs: false
        }, (downloadId) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            activeDownloadId = downloadId;
            const listener = (delta) => {
              if (delta.id === downloadId) {
                if (delta.state && delta.state.current === 'complete') {
                  chrome.downloads.onChanged.removeListener(listener);
                  resolve();
                } else if (delta.state && delta.state.current === 'interrupted') {
                  chrome.downloads.onChanged.removeListener(listener);
                  reject(new Error("Download interrupted"));
                }
              }
            };
            chrome.downloads.onChanged.addListener(listener);
          }
        });
      });
    } catch (err) {
      console.error(`Error downloading item ${item.id}:`, err);
    }

    if (abortDownload) return;

    const currentCount = i + 1;
    const percent = Math.round((currentCount / total) * 100);
    const done = currentCount === total;

    await saveDownloadState({
      isDownloading: !done,
      current: currentCount,
      total: total,
      percent: percent,
      done: done,
      error: null,
      downloadType: 'folder'
    });
  }
}

/* ──────────────────────────────────────────────────────────────────────────────
 *  Background ZIP builder
 * ──────────────────────────────────────────────────────────────────────────── */
async function runZipDownload(items, platform) {
  const total = items.length;
  const zip = new JSZip();
  const platformFolder = platform === 'tiktok' ? 'TikTok' : 'Instagram';
  const folder = zip.folder(`SocialBulk_${platformFolder}`);

  for (let i = 0; i < total; i++) {
    if (abortDownload) return;

    const item = items[i];
    try {
      let resolvedUrl = await resolveMediaUrl(item, platform);
      if (!resolvedUrl) {
        console.warn(`Skipping item ${item.id} for ZIP: could not resolve to a downloadable URL`);
        folder.file(`${item.id}_unresolvable.txt`, `Could not resolve to a direct video URL.\nOriginal URL: ${item.url}`);
        continue;
      }

      currentAbortController = new AbortController();
      const blob = await robustFetchBlob(resolvedUrl, currentAbortController.signal);

      if (blob && blob.size > 0) {
        // Verify it's actually video content, not an error page
        const isVideo = blob.type.includes('video/') ||
                        blob.type.includes('octet-stream') ||
                        (blob.size > 100000 && !blob.type.includes('text/html') && !blob.type.includes('image/'));

        const cleanTitle = (item.title || 'media_item')
          .slice(0, 50)
          .replace(/[^a-zA-Z0-9_-]/g, '_')
          .replace(/_+/g, '_');
        const filename = `${item.id}_${cleanTitle}.mp4`;

        if (isVideo) {
          folder.file(filename, blob);
        } else if (blob.type.includes('image/')) {
          folder.file(filename.replace('.mp4', '_cover.jpg'), blob);
        } else {
          folder.file(`${item.id}_error_info.txt`,
            `Fetched content was not video (type: ${blob.type}, size: ${blob.size}).\nURL: ${resolvedUrl}`);
        }
      } else {
        throw new Error("All fetch strategies returned empty or null");
      }
    } catch (err) {
      console.error(`Failed to fetch media for ZIP (${item.id}):`, err.message || err);
      folder.file(`${item.id}_error_info.txt`,
        `Failed to fetch video: ${err.message || err}\nURL: ${item.url}`);
    }

    if (abortDownload) return;

    const currentCount = i + 1;
    const percent = Math.round((currentCount / total) * 90);
    await saveDownloadState({
      isDownloading: true,
      current: currentCount,
      total: total,
      percent: percent,
      done: false,
      error: null,
      downloadType: 'zip'
    });
  }

  if (abortDownload) return;

  try {
    const content = await zip.generateAsync({ type: "blob" });
    const dataUrl = await blobToDataURL(content);

    if (abortDownload) return;

    await new Promise((resolve, reject) => {
      chrome.downloads.download({
        url: dataUrl,
        filename: `SocialBulk_${platformFolder}_Bundle_${Date.now()}.zip`,
        saveAs: false
      }, (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          activeDownloadId = downloadId;
          resolve();
        }
      });
    });

    await saveDownloadState({
      isDownloading: false,
      current: total,
      total: total,
      percent: 100,
      done: true,
      error: null,
      downloadType: 'zip'
    });
  } catch (err) {
    console.error("ZIP creation failed:", err);
    await saveDownloadState({
      isDownloading: false,
      current: total,
      total: total,
      percent: 0,
      done: false,
      error: err.message,
      downloadType: 'zip'
    });
  }
}

/* ──────────────────────────────────────────────────────────────────────────────
 *  Download orchestrator
 * ──────────────────────────────────────────────────────────────────────────── */
async function startDownload(items, platform, downloadType) {
  activeQueue = [...items];
  abortDownload = false;
  currentPlatform = platform;
  currentDownloadType = downloadType;

  const state = {
    isDownloading: true,
    current: 0,
    total: items.length,
    percent: 0,
    done: false,
    error: null,
    downloadType: downloadType
  };
  await saveDownloadState(state);

  if (downloadType === 'zip') {
    runZipDownload(items, platform);
  } else {
    runFolderDownload(items, platform);
  }
}

function cancelDownload() {
  abortDownload = true;
  if (currentAbortController) {
    currentAbortController.abort();
  }
  if (activeDownloadId !== null) {
    chrome.downloads.cancel(activeDownloadId).catch(() => {});
    activeDownloadId = null;
  }
  activeQueue = [];
  saveDownloadState({
    isDownloading: false,
    current: 0,
    total: 0,
    percent: 0,
    done: false,
    error: "Cancelled by user",
    downloadType: currentDownloadType
  });
}

/* ──────────────────────────────────────────────────────────────────────────────
 *  Keep-alive alarm & message listeners
 * ──────────────────────────────────────────────────────────────────────────── */
chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    // Touching an API keeps the service worker alive during long downloads
    if (abortDownload === false && activeQueue.length > 0) {
      console.log("Keep-alive tick – download in progress");
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_DOWNLOAD') {
    startDownload(message.items, message.platform, message.downloadType);
    sendResponse({ success: true });
    return true;
  }
  if (message.type === 'INSTABULK_CANCEL_DOWNLOAD') {
    cancelDownload();
    sendResponse({ success: true });
    return true;
  }
  if (message.type === 'GET_DOWNLOAD_STATUS') {
    chrome.storage.local.get('downloadState', (res) => {
      sendResponse({ downloadState: res.downloadState || null });
    });
    return true;
  }
});
