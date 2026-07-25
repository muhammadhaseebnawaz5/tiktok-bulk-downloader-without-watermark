(() => {
  if (globalThis.__socialBulkContentInstalled) return;
  globalThis.__socialBulkContentInstalled = true;

  const isInstagram = window.location.hostname.includes("instagram.com");
  const isTiktok = window.location.hostname.includes("tiktok.com");
  const platform = isInstagram ? "instagram" : isTiktok ? "tiktok" : "unknown";

  console.log(`SocialBulk Pro content script loaded on: ${window.location.hostname} (Platform: ${platform})`);

  let injected = false;
  let acquiring = false;
  let targetLimit = 0;
  let fromTs = null;
  let toTs = null;
  let uniqueHarvestedVideos = new Map();
  let scrollTimeout = null;
  let previousScrollHeight = 0;
  let lastKnownUrl = window.location.href;
  let lastKnownProfile = extractProfileHandle();

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Validates that a URL is a DIRECT video media stream (CDN link),
   * NOT a page navigation link.
   */
  function isDirectVideoUrl(url) {
    if (!url || typeof url !== 'string') return false;
    if (/^https?:\/\/(www\.)?instagram\.com\/(reel|p|tv)\//i.test(url)) return false;
    if (/^https?:\/\/(www\.)?tiktok\.com\/@/i.test(url)) return false;
    if (url.includes('cdninstagram.com')) return true;
    if (url.includes('fbcdn.net')) return true;
    if (url.includes('scontent')) return true;
    if (url.includes('tiktokcdn.com')) return true;
    if (url.includes('tiktokcdn-us.com')) return true;
    if (url.includes('tikwm.com')) return true;
    if (/\.mp4/i.test(url)) return true;
    if (url.includes('video/tos/')) return true;
    if (url.startsWith('blob:')) return true;
    return false;
  }

  /**
   * Extracts the current profile handle from the URL.
   * Instagram: /username/ or /username/reels/
   * TikTok: /@username
   */
  function extractProfileHandle() {
    const path = window.location.pathname;
    if (isInstagram) {
      const match = path.match(/^\/([^\/]+)/);
      return match ? match[1].toLowerCase() : '';
    }
    if (isTiktok) {
      const match = path.match(/^\/@([^\/]+)/);
      return match ? match[1].toLowerCase() : '';
    }
    return '';
  }

  /**
   * Detects URL/profile changes and auto-resets session when navigating
   * to a different profile page. Uses polling because Instagram/TikTok
   * are SPAs that don't trigger traditional page loads.
   */
  function startUrlChangeDetector() {
    setInterval(() => {
      const currentUrl = window.location.href;
      if (currentUrl !== lastKnownUrl) {
        const newProfile = extractProfileHandle();
        const profileChanged = newProfile !== lastKnownProfile && newProfile !== '';

        lastKnownUrl = currentUrl;

        if (profileChanged) {
          console.log(`SocialBulk: Profile changed from "${lastKnownProfile}" to "${newProfile}" — resetting session`);
          lastKnownProfile = newProfile;

          // Stop any running acquisition
          if (acquiring) {
            stopAcquiring("url_change", "Profile changed, session reset.");
          }

          // Wipe harvested data for old profile
          uniqueHarvestedVideos.clear();
          chrome.storage.local.set({ socialBulkItems: [], socialBulkProfile: newProfile });
        }
      }
    }, 1000);
  }

  function inject() {
    if (injected) return;
    injected = true;
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("inject.js");
    s.dataset.socialbulk = "1";
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  }

  // FLOATING DOWNLOAD OVERLAY SYSTEM (Shadow DOM)
  let shadowRoot = null;
  let overlayContainer = null;
  let overlaySuppressed = false;

  function createOverlay() {
    if (overlayContainer || overlaySuppressed) return;

    overlayContainer = document.createElement('div');
    overlayContainer.id = 'socialbulk-overlay-container';
    overlayContainer.style.position = 'fixed';
    overlayContainer.style.bottom = '20px';
    overlayContainer.style.right = '20px';
    overlayContainer.style.zIndex = '2147483647';
    overlayContainer.style.pointerEvents = 'auto';
    document.body.appendChild(overlayContainer);

    shadowRoot = overlayContainer.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      .overlay-modal {
        width: 340px;
        padding: 18px;
        border-radius: 16px;
        background: rgba(15, 23, 42, 0.95);
        backdrop-filter: blur(12px);
        border: 1px solid rgba(255, 255, 255, 0.1);
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
        color: #ffffff;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        box-sizing: border-box;
        transition: opacity 0.5s ease, transform 0.5s ease;
        opacity: 1;
        transform: translateY(0);
      }
      .overlay-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 14px;
      }
      .overlay-title {
        font-size: 13px;
        font-weight: 700;
        color: #3b82f6;
        margin: 0;
        text-transform: uppercase;
        letter-spacing: 0.8px;
      }
      .btn-cancel {
        background: none;
        border: none;
        color: #64748b;
        font-size: 16px;
        font-weight: bold;
        cursor: pointer;
        padding: 4px;
        line-height: 1;
        transition: color 0.2s, transform 0.2s;
      }
      .btn-cancel:hover {
        color: #ef4444;
        transform: scale(1.15);
      }
      .progress-info {
        display: flex;
        justify-content: space-between;
        font-size: 12px;
        color: #94a3b8;
        margin-bottom: 8px;
        font-weight: 500;
      }
      .progress-bar-container {
        width: 100%;
        height: 8px;
        background: rgba(255, 255, 255, 0.08);
        border-radius: 4px;
        overflow: hidden;
        margin-bottom: 6px;
      }
      .progress-bar-fill {
        width: 0%;
        height: 100%;
        background: linear-gradient(90deg, #3b82f6, #10b981);
        border-radius: 4px;
        transition: width 0.3s ease;
      }
      .percentage {
        font-weight: 700;
        color: #10b981;
      }
      .fade-out {
        opacity: 0 !important;
        transform: translateY(20px) !important;
      }
    `;

    const modal = document.createElement('div');
    modal.className = 'overlay-modal';
    modal.innerHTML = `
      <div class="overlay-header">
        <h3 class="overlay-title">Downloading Media</h3>
        <button class="btn-cancel" title="Cancel Download">✖</button>
      </div>
      <div class="progress-bar-container">
        <div class="progress-bar-fill"></div>
      </div>
      <div class="progress-info">
        <span class="status-text">Downloaded 0 / 0</span>
        <span class="percentage">0%</span>
      </div>
    `;

    shadowRoot.appendChild(style);
    shadowRoot.appendChild(modal);

    modal.querySelector('.btn-cancel').onclick = () => {
      overlaySuppressed = true;
      chrome.runtime.sendMessage({ type: 'INSTABULK_CANCEL_DOWNLOAD' });
      chrome.storage.local.set({ downloadState: { isDownloading: false, current: 0, total: 0, percent: 0, done: false, error: 'Cancelled by user' } });
      hideOverlay();
    };
  }

  function updateOverlay(state) {
    if (overlaySuppressed) {
      if (state && state.isDownloading && state.current === 0 && state.total > 0) {
        overlaySuppressed = false;
      } else {
        return;
      }
    }

    if (!state || !state.isDownloading) {
      if (state && state.done) {
        createOverlay();
        if (!shadowRoot) return;
        const modal = shadowRoot.querySelector('.overlay-modal');
        const barFill = shadowRoot.querySelector('.progress-bar-fill');
        const statusText = shadowRoot.querySelector('.status-text');
        const percentageText = shadowRoot.querySelector('.percentage');
        const titleText = shadowRoot.querySelector('.overlay-title');

        if (titleText) {
          titleText.textContent = "Download Complete";
          titleText.style.color = "#10b981";
        }
        if (barFill) barFill.style.width = '100%';
        if (statusText) statusText.textContent = `Done! All items saved.`;
        if (percentageText) percentageText.textContent = '100%';

        setTimeout(() => {
          if (modal) {
            modal.classList.add('fade-out');
            setTimeout(hideOverlay, 500);
          }
        }, 2000);
      } else {
        hideOverlay();
      }
      return;
    }

    createOverlay();
    if (!shadowRoot) return;
    const barFill = shadowRoot.querySelector('.progress-bar-fill');
    const statusText = shadowRoot.querySelector('.status-text');
    const percentageText = shadowRoot.querySelector('.percentage');

    if (barFill) barFill.style.width = `${state.percent}%`;
    const label = state.downloadType === 'zip' ? 'Packaging' : 'Downloaded';
    if (statusText) statusText.textContent = `${label} ${state.current} / ${state.total}`;
    if (percentageText) percentageText.textContent = `${state.percent}%`;
  }

  function hideOverlay() {
    if (overlayContainer) {
      overlayContainer.remove();
      overlayContainer = null;
      shadowRoot = null;
    }
  }

  // HARVESTERS
  async function handleIncomingItems(newItems) {
    if (!acquiring || !Array.isArray(newItems) || !newItems.length) return;

    let newlyAdded = false;

    for (const item of newItems) {
      if (item.platform !== platform) continue;

      // CRITICAL: reject items that don't have a direct CDN video URL
      if (!item.url || !isDirectVideoUrl(item.url)) continue;

      if (targetLimit > 0 && uniqueHarvestedVideos.size >= targetLimit) {
        await stopAcquiring("limit", `Acquired target limit ${targetLimit} items.`);
        break;
      }

      if (fromTs !== null || toTs !== null) {
        const stamp = item.taken_at_timestamp;
        if (fromTs !== null && stamp && stamp < fromTs) {
          await stopAcquiring("date_range_end", "Stopped because posts older than the From date were reached.");
          break;
        }
        if (fromTs !== null && (!stamp || stamp < fromTs)) continue;
        if (toTs !== null && (!stamp || stamp > toTs)) continue;
      }

      if (!uniqueHarvestedVideos.has(item.id)) {
        uniqueHarvestedVideos.set(item.id, item);
        newlyAdded = true;

        chrome.runtime.sendMessage({ type: "INSTABULK_ITEM" }).catch(() => {});
      }
    }

    if (newlyAdded) {
      const allItems = Array.from(uniqueHarvestedVideos.values());
      await chrome.storage.local.set({ socialBulkItems: allItems });
    }
  }

  /**
   * Instagram DOM Scraper — extracts ONLY direct video src from <video> elements.
   * Does NOT harvest <a href="/reel/..."> page navigation anchors.
   */
  function harvestInstagramFromDOM() {
    const collected = [];

    // Extract from <video> elements — these have direct CDN src
    document.querySelectorAll("video").forEach((video) => {
      const url = video.currentSrc || video.src || "";
      if (!url || !isDirectVideoUrl(url)) return;

      // Try to find a unique ID from nearby DOM context
      let id = video.getAttribute("data-video-id") || '';
      if (!id) {
        // Try to extract shortcode from nearest ancestor anchor
        const ancestor = video.closest('a[href*="/reel/"], a[href*="/p/"]');
        if (ancestor) {
          const href = ancestor.getAttribute("href") || "";
          id = href.split("/").filter(Boolean).pop() || '';
        }
      }
      if (!id) {
        // Generate a unique ID from URL hash
        id = 'vid_' + url.split('?')[0].split('/').pop().replace(/[^a-z0-9]/gi, '_').slice(0, 40);
      }

      collected.push({
        id: id,
        platform: 'instagram',
        url: url,
        title: `Instagram Video ${id}`,
        taken_at_timestamp: Math.floor(Date.now() / 1000)
      });
    });

    // Also check <video><source src="..."></video>
    document.querySelectorAll("video source").forEach((source) => {
      const url = source.src || source.getAttribute("src") || "";
      if (!url || !isDirectVideoUrl(url)) return;

      const videoEl = source.closest("video");
      let id = videoEl?.getAttribute("data-video-id") || '';
      if (!id) {
        id = 'src_' + url.split('?')[0].split('/').pop().replace(/[^a-z0-9]/gi, '_').slice(0, 40);
      }

      collected.push({
        id: id,
        platform: 'instagram',
        url: url,
        title: `Instagram Video ${id}`,
        taken_at_timestamp: Math.floor(Date.now() / 1000)
      });
    });

    if (collected.length > 0) {
      handleIncomingItems(collected);
    }
  }

  // TikTok DOM Scraper & Embedded JSON Sweeper
  function harvestTikTokFromDOM() {
    const videoLinks = document.querySelectorAll('a[href*="/video/"]');
    const records = [];

    videoLinks.forEach(link => {
      const href = link.href;
      const match = href.match(/\/video\/(\d+)/);
      if (match && match[1]) {
        const vid = match[1];
        let title = link.getAttribute('title') || link.querySelector('img')?.getAttribute('alt') || '';
        if (!title || /^[0-9.,]+\s*[KMB]?$/i.test(title.trim())) {
          title = `TikTok_Video_${vid}`;
        }

        let ts = Math.floor(Date.now() / 1000);
        try {
          const idBig = BigInt(vid);
          if (idBig > 1000000000000n) {
            ts = Number(idBig >> 32n);
          }
        } catch (e) {}

        // For TikTok DOM, we store the page link as URL — background.js
        // will resolve it to a direct stream via TikWM API before downloading
        records.push({
          id: vid,
          platform: 'tiktok',
          url: href,
          title: title,
          taken_at_timestamp: ts
        });
      }
    });

    if (records.length > 0) {
      handleIncomingItems(records);
    }
  }

  function extractTikTokInitialState() {
    try {
      const scripts = document.querySelectorAll('script[id="__UNIVERSAL_DATA_FOR_REHYDRATION__"], script[id="SIGI_STATE"]');
      scripts.forEach(script => {
        if (script && script.textContent) {
          const data = JSON.parse(script.textContent);
          parseTikTokJsonData(data);
        }
      });
    } catch (e) {
      console.warn("Could not parse embedded TikTok state:", e);
    }
    harvestTikTokFromDOM();
  }

  function parseTikTokJsonData(data) {
    try {
      let itemMap = null;
      if (data && data.__DEFAULT_SCOPE__ && data.__DEFAULT_SCOPE__['webapp.video-detail']) {
        const detail = data.__DEFAULT_SCOPE__['webapp.video-detail'];
        if (detail.itemInfo && detail.itemInfo.itemStruct) {
          addTikTokRecord(detail.itemInfo.itemStruct);
        }
      }
      
      if (data && data.ItemModule) {
        itemMap = data.ItemModule;
      } else if (data && data.__DEFAULT_SCOPE__ && data.__DEFAULT_SCOPE__['webapp.user-detail']) {
        const userDetail = data.__DEFAULT_SCOPE__['webapp.user-detail'];
        if (userDetail.itemList) {
          userDetail.itemList.forEach(item => addTikTokRecord(item));
        }
      }

      if (itemMap) {
        Object.values(itemMap).forEach(item => addTikTokRecord(item));
      }
    } catch (err) {
      console.error("Error parsing TikTok JSON structure:", err);
    }
  }

  function addTikTokRecord(item) {
    if (!item || !item.id) return;
    const vid = String(item.id);
    let ts = Math.floor(Date.now() / 1000);
    try {
      const idBig = BigInt(vid);
      if (idBig > 1000000000000n) {
        ts = Number(idBig >> 32n);
      }
    } catch (e) {}

    const url = item.video && (item.video.downloadAddr || item.video.playAddr || item.video.playAddrH264) ? item.video.downloadAddr || item.video.playAddr || item.video.playAddrH264 : `https://www.tiktok.com/@user/video/${vid}`;

    const record = {
      id: vid,
      platform: 'tiktok',
      url: url,
      title: item.desc || item.title || `TikTok Video ${vid}`,
      taken_at_timestamp: item.createTime || ts
    };
    handleIncomingItems([record]);
  }

  // AUTO-SCROLL LOOP
  function performScroll(amount) {
    window.scrollBy(0, amount);
    if (document.documentElement) {
      document.documentElement.scrollTop += amount;
    }
    if (document.body) {
      document.body.scrollTop += amount;
    }
    
    const containers = [
      document.querySelector('main[role="main"]'),
      document.querySelector('div[style*="overflow-y: auto"]'),
      document.querySelector('div[style*="overflow-y: scroll"]'),
      document.querySelector('article')?.parentElement
    ];
    containers.forEach(container => {
      if (container) {
        container.scrollTop += amount;
      }
    });
  }

  function getScrollHeight() {
    let max = document.body ? document.body.scrollHeight : 0;
    if (document.documentElement && document.documentElement.scrollHeight > max) {
      max = document.documentElement.scrollHeight;
    }
    const containers = [
      document.querySelector('main[role="main"]'),
      document.querySelector('div[style*="overflow-y: auto"]'),
      document.querySelector('div[style*="overflow-y: scroll"]'),
      document.querySelector('article')?.parentElement
    ];
    containers.forEach(container => {
      if (container && container.scrollHeight > max) {
        max = container.scrollHeight;
      }
    });
    return max;
  }

  function startScrolling() {
    if (scrollTimeout) {
      clearTimeout(scrollTimeout);
      scrollTimeout = null;
    }
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    previousScrollHeight = getScrollHeight();
    scrollTimeout = setTimeout(scrollCycle, 1500);
  }

  async function scrollCycle() {
    if (!acquiring) return;

    try {
      previousScrollHeight = getScrollHeight();
      performScroll(700);
      await wait(500);

      if (isInstagram) {
        harvestInstagramFromDOM();
      } else if (isTiktok) {
        harvestTikTokFromDOM();
        extractTikTokInitialState();
      }

      const currentScrollHeight = getScrollHeight();
      if (currentScrollHeight === previousScrollHeight) {
        performScroll(-200);
        await wait(200);
        performScroll(200);
        await wait(200);

        if (isInstagram) {
          harvestInstagramFromDOM();
        } else if (isTiktok) {
          harvestTikTokFromDOM();
        }
      }
    } catch (e) {
      console.error("Error in scroll cycle:", e);
    }

    if (acquiring) {
      scrollTimeout = setTimeout(scrollCycle, 1500);
    }
  }

  async function stopAcquiring(reason, note) {
    if (!acquiring) return;
    acquiring = false;
    if (scrollTimeout) {
      clearTimeout(scrollTimeout);
      scrollTimeout = null;
    }

    window.postMessage({ source: "SOCIALBULK_CONTENT", type: "STOP" }, "*");
    chrome.runtime.sendMessage({
      type: "INSTABULK_AUTO_STOP",
      reason,
      note,
      platform
    }).catch(() => {});
  }

  // INITIALIZATION & LISTENERS
  if (isInstagram || isTiktok) {
    inject();
    startUrlChangeDetector();

    // Store current profile handle so popup.js can compare later
    chrome.storage.local.set({ socialBulkProfile: lastKnownProfile });
  }

  window.addEventListener("message", async (e) => {
    if (e.source !== window || e.data?.source !== "SOCIALBULK_MAIN") return;
    if (e.data.type === "MEDIA_BATCH") {
      await handleIncomingItems(Array.isArray(e.data.items) ? e.data.items : []);
    }
  });

  chrome.runtime.onMessage.addListener((m, _s, reply) => {
    if (m.type === "INSTABULK_ACQUIRE") {
      (async () => {
        acquiring = true;
        targetLimit = Number(m.newestLimit) || 0;
        fromTs = m.fromTs ? Number(m.fromTs) : null;
        toTs = m.toTs ? Number(m.toTs) : null;

        // Always reset on fresh acquisition
        uniqueHarvestedVideos.clear();
        lastKnownProfile = extractProfileHandle();
        lastKnownUrl = window.location.href;

        await chrome.storage.local.set({ socialBulkItems: [], socialBulkProfile: lastKnownProfile });

        inject();
        window.postMessage(
          {
            source: "SOCIALBULK_CONTENT",
            type: "START"
          },
          "*"
        );

        if (isInstagram) {
          harvestInstagramFromDOM();
        } else if (isTiktok) {
          harvestTikTokFromDOM();
          extractTikTokInitialState();
        }

        startScrolling();
        reply({ ok: true });
      })();
      return true;
    }

    if (m.type === "INSTABULK_STOP") {
      (async () => {
        await stopAcquiring("stopped", "User stopped acquisition.");
        reply({ ok: true });
      })();
      return true;
    }

    if (m.type === "GET_STATUS") {
      reply({
        platform: platform,
        isAcquiring: acquiring,
        videos: Array.from(uniqueHarvestedVideos.values()),
        profile: lastKnownProfile
      });
      return true;
    }

    if (m.type === 'INSTABULK_DOWNLOAD_PROGRESS') {
      updateOverlay(m);
      reply({ ok: true });
      return true;
    }

    return false;
  });

  // Restore session items from local storage ONLY for the current profile
  chrome.storage.local.get(["socialBulkItems", "downloadState", "socialBulkProfile"]).then((r) => {
    const storedProfile = r.socialBulkProfile || '';
    const currentProfile = extractProfileHandle();

    // Only restore items if we're on the same profile
    if (storedProfile === currentProfile && !acquiring) {
      const stored = r.socialBulkItems || [];
      stored.forEach((item) => {
        if (item.platform === platform && item.url && isDirectVideoUrl(item.url)) {
          uniqueHarvestedVideos.set(item.id, item);
        }
      });
    } else if (storedProfile !== currentProfile) {
      // Different profile — wipe stale data
      chrome.storage.local.set({ socialBulkItems: [], socialBulkProfile: currentProfile });
    }

    if (r.downloadState && r.downloadState.isDownloading) {
      updateOverlay(r.downloadState);
    }
  });
})();
