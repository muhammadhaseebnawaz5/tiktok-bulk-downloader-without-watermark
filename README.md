# SocialBulk Pro

![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue?style=flat-square&logo=googlechrome)
![Platforms](https://img.shields.io/badge/Platforms-Instagram%20%7C%20TikTok-ff0050?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)
![Version](https://img.shields.io/badge/Version-1.0.0-orange?style=flat-square)
![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)

A unified Chrome Extension that bulk-harvests and downloads Instagram Reels & TikTok videos — all from a single popup.

---

## ✨ Features

- **Dual Platform** — Detects Instagram or TikTok automatically from the active tab
- **Smart Harvesting** — Auto-scrolls the page and intercepts GraphQL/XHR responses to capture direct CDN video URLs
- **Filters** — Limit to newest N items or filter by date range (From / To)
- **Save to Folder** — Downloads files sequentially into `SocialBulk/Instagram/` or `SocialBulk/TikTok/`
- **Download ZIP** — Packages all videos into a single `.zip` bundle via JSZip
- **Export JSON** — Saves harvested MP4 links as a JSON file
- **Live Overlay** — Floating Shadow DOM progress modal injected into the page (persists across popup closes)
- **Cancel Anytime** — ✖ button on the overlay instantly aborts all pending downloads
- **CORS Bypass** — Uses `declarativeNetRequest` header rules + 3-strategy fetch fallback to get past CDN hotlink protection
- **Session Reset** — Automatically detects profile/URL changes and wipes stale data

---

## 🚀 Installation

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select this folder

---

## 📖 Usage

1. Open an **Instagram** profile page or **TikTok** profile page
2. Click the **SocialBulk Pro** icon in your toolbar
3. *(Optional)* Set a limit or date range filter
4. Click **▶ Start Acquiring** — the extension scrolls and harvests automatically
5. Click **Stop Acquiring** when done
6. Choose **Save to Folder**, **Download .zip**, or **Export JSON**

---

## ⚠️ Disclaimer

This tool is intended for downloading content **you own or are authorized to download**. Respect platform Terms of Service and copyright laws.
