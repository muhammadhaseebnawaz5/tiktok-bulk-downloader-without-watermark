(() => {
  if (window.__socialBulkInjectInstalled) return;
  window.__socialBulkInjectInstalled = true;

  let running = false;
  let interceptedMediaCache = [];
  let seenIds = new Set();

  const stamp = (v) => {
    const n = Number(v);
    return n ? (n > 1e12 ? Math.floor(n / 1000) : n) : null;
  };

  /**
   * Validates that a URL is a DIRECT video media stream (CDN link),
   * NOT a page navigation link like https://www.instagram.com/reel/Cxxx/
   */
  function isDirectVideoUrl(url) {
    if (!url || typeof url !== 'string') return false;
    // Reject page navigation links
    if (/^https?:\/\/(www\.)?instagram\.com\/(reel|p|tv)\//i.test(url)) return false;
    if (/^https?:\/\/(www\.)?tiktok\.com\/@/i.test(url)) return false;
    // Accept known CDN domains
    if (url.includes('cdninstagram.com')) return true;
    if (url.includes('fbcdn.net')) return true;
    if (url.includes('scontent')) return true;
    if (url.includes('tiktokcdn.com')) return true;
    if (url.includes('tiktokcdn-us.com')) return true;
    if (url.includes('tikwm.com')) return true;
    // Accept .mp4 extension
    if (/\.mp4/i.test(url)) return true;
    // Accept video content type hints in URL
    if (url.includes('video/tos/') || url.includes('/video/')) return true;
    // Accept blob URLs (from <video> elements)
    if (url.startsWith('blob:')) return true;
    return false;
  }

  function extractBestVideoUrl(value) {
    if (!value || typeof value !== 'object') return null;

    // Priority 1: video_versions array (Instagram GraphQL — always direct CDN)
    if (Array.isArray(value.video_versions) && value.video_versions.length > 0) {
      // Sort by width descending to get highest quality first
      const sorted = [...value.video_versions].sort((a, b) => (b.width || 0) - (a.width || 0));
      for (const v of sorted) {
        if (v.url && isDirectVideoUrl(v.url)) return v.url;
      }
      // Fallback: take first available
      if (value.video_versions[0]?.url) return value.video_versions[0].url;
    }

    // Priority 2: video_dash_manifest.video_versions
    if (value.video_dash_manifest?.video_versions) {
      const versions = value.video_dash_manifest.video_versions;
      for (const v of versions) {
        if (v.url && isDirectVideoUrl(v.url)) return v.url;
      }
    }

    // Priority 3: video_resources array
    if (Array.isArray(value.video_resources)) {
      for (const v of value.video_resources) {
        const u = v.src || v.url;
        if (u && isDirectVideoUrl(u)) return u;
      }
    }

    // Priority 4: explicit video_url field (Instagram API v1)
    if (value.video_url && isDirectVideoUrl(value.video_url)) return value.video_url;
    if (value.videoUrl && isDirectVideoUrl(value.videoUrl)) return value.videoUrl;

    // Priority 5: generic .url / .src but ONLY if it's a real CDN link
    if (value.url && isDirectVideoUrl(value.url)) return value.url;
    if (value.src && isDirectVideoUrl(value.src)) return value.src;

    return null;
  }

  function normalizeNode(value) {
    if (!value || typeof value !== "object") return null;

    // 1. TikTok video node structure
    const isTiktok = Boolean(value.id && value.video && (value.video.playAddr || value.video.downloadAddr || value.video.playAddrH264));
    if (isTiktok) {
      const vid = String(value.id);
      let ts = Math.floor(Date.now() / 1000);
      try {
        const idBig = BigInt(vid);
        if (idBig > 1000000000000n) {
          ts = Number(idBig >> 32n);
        }
      } catch (e) {}

      const url = value.video.downloadAddr || value.video.playAddr || value.video.playAddrH264 || '';
      if (!url) return null;

      return {
        id: vid,
        platform: 'tiktok',
        url: url,
        title: value.desc || value.title || `TikTok Video ${vid}`,
        taken_at_timestamp: value.createTime || ts
      };
    }

    // 2. Instagram media node structure — must have actual video data
    const hasVideoData = Boolean(
      value.video_versions ||
      value.video_dash_manifest ||
      value.video_resources ||
      (value.video_url && isDirectVideoUrl(value.video_url)) ||
      (value.videoUrl && isDirectVideoUrl(value.videoUrl))
    );

    // Also match items explicitly marked as video
    const isMarkedVideo = Boolean(value.is_video || value.media_type === 2);

    if (hasVideoData || isMarkedVideo) {
      const id = value.id || value.media_id || value.pk || value.code || value.shortcode || '';
      if (!id) return null;

      const url = extractBestVideoUrl(value);
      // CRITICAL: Do NOT accept items without a real direct video URL
      if (!url) return null;

      return {
        id: String(id),
        platform: 'instagram',
        url: url,
        title: value.caption?.text || value.title || `Instagram Reel ${id}`,
        taken_at_timestamp: stamp(value.taken_at_timestamp || value.device_timestamp || value.taken_at || 0)
      };
    }

    return null;
  }

  function collectMediaFromPayload(payload) {
    const collected = [];
    const visit = (value) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }

      const normalized = normalizeNode(value);
      if (normalized && normalized.url) {
        collected.push(normalized);
        return;
      }

      Object.values(value).forEach(visit);
    };

    visit(payload);
    return collected;
  }

  function emitBatch(items) {
    // Double-check: only emit items with valid direct video URLs
    const validItems = items.filter(item => item.url && isDirectVideoUrl(item.url));
    const uniqueItems = [];
    for (const item of validItems) {
      if (!seenIds.has(item.id)) {
        seenIds.add(item.id);
        uniqueItems.push(item);
      }
    }
    if (uniqueItems.length > 0) {
      window.postMessage(
        { source: "SOCIALBULK_MAIN", type: "MEDIA_BATCH", items: uniqueItems },
        "*"
      );
    }
  }

  function consume(text) {
    try {
      const payload = JSON.parse(text);
      const items = collectMediaFromPayload(payload);
      if (items.length) {
        if (running) {
          emitBatch(items);
        } else {
          interceptedMediaCache.push(...items);
        }
      }
    } catch {}
  }

  // Intercept window.fetch
  const nativeFetch = window.fetch;
  window.fetch = async function (input, init = {}) {
    try {
      const response = await nativeFetch.call(this, input, init);
      const url = String(input?.url || input);
      if (
        url.includes("instagram.com") ||
        url.includes("tiktok.com") ||
        url.includes("/api/") ||
        url.includes("/graphql")
      ) {
        response.clone().text().then(consume).catch(() => {});
      }
      return response;
    } catch (e) {
      return nativeFetch.call(this, input, init);
    }
  };

  // Intercept XMLHttpRequest
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__sbUrl = String(url);
    return open.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", () => {
      const url = this.__sbUrl || "";
      if (
        (url.includes("instagram.com") ||
         url.includes("tiktok.com") ||
         url.includes("/api/") ||
         url.includes("/graphql")) &&
        this.responseType !== "arraybuffer" &&
        this.responseType !== "blob"
      ) {
        consume(typeof this.response === "string" ? this.response : this.responseText);
      }
    });
    return send.apply(this, args);
  };

  // Scan global variables on load
  function collectFromGlobals() {
    const collected = [];
    if (window._sharedData) {
      collected.push(...collectMediaFromPayload(window._sharedData));
    }
    if (window.__additionalDataLoaded) {
      collected.push(...collectMediaFromPayload(window.__additionalDataLoaded));
    }
    return collected;
  }

  // Handle messages from content.js
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.source !== "SOCIALBULK_CONTENT") return;

    if (e.data.type === "START") {
      running = true;
      seenIds.clear();
      const globalItems = collectFromGlobals();
      const combined = [...globalItems, ...interceptedMediaCache];
      interceptedMediaCache = [];
      if (combined.length > 0) {
        emitBatch(combined);
      }
    }
    if (e.data.type === "STOP") {
      running = false;
      seenIds.clear();
    }
  });
})();
