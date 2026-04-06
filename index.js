import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import { promises as fsp } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import axios from "axios";
import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";

// Load environment variables from .env
// Required: BOT_TOKEN
// Optional:
// - YTDLP_PATH (default: ./yt-dlp.exe on Windows, otherwise yt-dlp in PATH)
// - FFMPEG_LOCATION (directory containing ffmpeg/ffprobe)
// - YTDLP_JS_RUNTIMES (default: node; used for YouTube extraction)
// - YTDLP_PROXY (optional; e.g. http://user:pass@host:port)
// - COOKIES_FROM_BROWSER (e.g. chrome, edge, firefox)
dotenv.config({ quiet: true });

function readRequiredEnv(name) {
  const value = process.env[name]?.trim();
  if (value) {
    return value;
  }

  console.error(
    `[startup] Missing required environment variable ${name}. ` +
    "Set it in Railway Variables, Render environment settings, or your local .env file."
  );
  process.exit(1);
}

function readPositiveNumberEnv(name, fallbackValue) {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) {
    return fallbackValue;
  }

  const parsedValue = Number(rawValue);
  if (Number.isFinite(parsedValue) && parsedValue > 0) {
    return parsedValue;
  }

  console.warn(
    `[startup] Invalid ${name}=${JSON.stringify(rawValue)}. ` +
    `Falling back to ${fallbackValue}.`
  );
  return fallbackValue;
}

const BOT_TOKEN = readRequiredEnv("BOT_TOKEN");
if (!/^\d+:[\w-]+$/.test(BOT_TOKEN)) {
  console.warn(
    "[startup] BOT_TOKEN does not look like a standard Telegram bot token. " +
    "Polling will keep retrying until the token is corrected."
  );
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DOWNLOAD_DIR = path.join(__dirname, "downloads");
const TELEGRAM_CLOUD_LIMIT_BYTES = 50 * 1024 * 1024; // 50MB on default Bot API server
const MAX_DOWNLOAD_MB = readPositiveNumberEnv("MAX_DOWNLOAD_MB", 200);
const MAX_DOWNLOAD_BYTES = MAX_DOWNLOAD_MB * 1024 * 1024;
const AUTO_DOWNLOAD = String(process.env.AUTO_DOWNLOAD ?? "true").trim().toLowerCase() !== "false";
const REDIRECT_TIMEOUT_MS = 15000;
const SELECTION_TTL_MS = 10 * 60 * 1000;

const YTDLP_PATH = process.env.YTDLP_PATH?.trim() ||
  process.env.YTDLP_BINARY_PATH?.trim() ||
  (process.platform === "win32" ? path.join(__dirname, "yt-dlp.exe") : "yt-dlp");

const FFMPEG_LOCATION = process.env.FFMPEG_LOCATION?.trim() ||
  process.env.YTDLP_FFMPEG_LOCATION?.trim() ||
  "";

const YTDLP_JS_RUNTIMES = process.env.YTDLP_JS_RUNTIMES?.trim() || "node";
const YTDLP_PROXY = process.env.YTDLP_PROXY?.trim() || "";

const COOKIES_FROM_BROWSER = process.env.COOKIES_FROM_BROWSER?.trim() ||
  process.env.YTDLP_COOKIES_FROM_BROWSER?.trim() ||
  "";
let cookiesTemporarilyDisabled = false;

// Shared browser-like headers improve redirect resolution on some platforms.
const RESOLVE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};
const DOUYIN_MOBILE_SHARE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36",
  Accept: RESOLVE_HEADERS.Accept,
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  Referer: "https://www.douyin.com/",
};
const KUAISHOU_MOBILE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
    "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  Accept: RESOLVE_HEADERS.Accept,
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};

// Initialize Telegram bot with polling.
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const pendingSelections = new Map();
const activeSelectionByChat = new Map();
let isShuttingDown = false;

function log(message, ...args) {
  const now = new Date().toISOString();
  console.log(`[${now}] ${message}`, ...args);
}

async function shutdown(signal) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  log(`[shutdown] Received ${signal}. Stopping Telegram polling.`);

  try {
    await bot.stopPolling();
  } catch (error) {
    log(`[shutdown] stopPolling failed: ${error?.message || String(error)}`);
  }

  process.exit(0);
}

function extractUrls(text) {
  const matches = text.match(/https?:\/\/[^\s]+/gi) || [];

  const cleaned = matches
    .map((value) => value.replace(/[)\]}",.!?，。；：”’]+$/g, ""))
    .filter(Boolean);

  return [...new Set(cleaned)];
}

function extractFirstUrl(text) {
  return extractUrls(text)[0] || null;
}

function formatMb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

function cleanupSelection(selectionId) {
  const selected = pendingSelections.get(selectionId);
  if (selected?.timer) {
    clearTimeout(selected.timer);
  }
  if (selected?.chatId && activeSelectionByChat.get(selected.chatId) === selectionId) {
    activeSelectionByChat.delete(selected.chatId);
  }
  pendingSelections.delete(selectionId);
}

function isUnsupportedUrlError(errorText) {
  return /unsupported url/i.test(errorText);
}

function isKuaishouShortVideoUrl(url) {
  return /(?:^|\/\/)(?:www\.)?kuaishou\.com\/short-video\//i.test(url);
}

function isKuaishouUrl(url) {
  return /(?:^|\/\/)(?:v\.kuaishou\.com|(?:www\.)?kuaishou\.com)\//i.test(url);
}

function isDouyinShortUrl(url) {
  return /(?:^|\/\/)v\.douyin\.com\//i.test(url);
}

function isDouyinSharePageUrl(url) {
  return /(?:^|\/\/)(?:www\.)?iesdouyin\.com\/share\/video\//i.test(url);
}

function isDouyinUrl(url) {
  return /(?:^|\/\/)(?:v\.douyin\.com|(?:www\.)?douyin\.com|(?:www\.)?iesdouyin\.com)\//i.test(url);
}

function extractDouyinVideoId(url) {
  if (typeof url !== "string") return null;

  const videoId =
    url.match(/douyin\.com\/video\/(\d+)(?:[/?#]|$)/i)?.[1] ||
    url.match(/iesdouyin\.com\/share\/video\/(\d+)(?:[/?#]|$)/i)?.[1];

  return videoId || null;
}

function isYouTubeUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return (
      host === "youtu.be" ||
      host === "youtube.com" ||
      host === "www.youtube.com" ||
      host === "m.youtube.com" ||
      host === "music.youtube.com" ||
      host === "youtube-nocookie.com" ||
      host === "www.youtube-nocookie.com"
    );
  } catch {
    return /(?:^|\/\/)(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\//i.test(url);
  }
}

function extractYouTubeVideoId(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    if (host === "youtu.be") {
      const pathId = parsed.pathname.split("/").filter(Boolean)[0];
      return /^[a-zA-Z0-9_-]{11}$/.test(pathId || "") ? pathId : null;
    }

    const watchId = parsed.searchParams.get("v");
    if (/^[a-zA-Z0-9_-]{11}$/.test(watchId || "")) {
      return watchId;
    }

    const pathParts = parsed.pathname.split("/").filter(Boolean);
    const pathCandidate = pathParts.length >= 2 &&
      ["shorts", "live", "embed", "watch"].includes(pathParts[0].toLowerCase())
      ? pathParts[1]
      : null;
    if (/^[a-zA-Z0-9_-]{11}$/.test(pathCandidate || "")) {
      return pathCandidate;
    }
  } catch {
    // Fallback to regex parsing for malformed inputs.
  }

  const watchId = url.match(/[?&]v=([a-zA-Z0-9_-]{11})(?:[&#]|$)/)?.[1];
  if (watchId) return watchId;

  const shortsId = url.match(/\/(?:shorts|live|embed)\/([a-zA-Z0-9_-]{11})(?:[/?&#]|$)/)?.[1];
  if (shortsId) return shortsId;

  const shortHostId = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})(?:[/?&#]|$)/)?.[1];
  if (shortHostId) return shortHostId;

  return null;
}

function buildYtDlpCandidateUrls(url) {
  const candidates = [url];
  if (!isYouTubeUrl(url)) return candidates;

  const videoId = extractYouTubeVideoId(url);
  if (!videoId) return candidates;

  return [
    `https://www.youtube.com/watch?v=${videoId}`,
    `https://www.youtube.com/shorts/${videoId}`,
    `https://youtu.be/${videoId}`
  ].concat(candidates).filter((value, index, values) => values.indexOf(value) === index);
}

function decodeEscapedUrl(value) {
  return value
    .replace(/\\u002F/g, "/")
    .replace(/\\u0026/g, "&")
    .replace(/\\\\/g, "\\");
}

function mapDirectSourcesToChoices(sources) {
  return sources.map((source, index) => ({
    text: source.label || `Direct ${index + 1}`,
    directUrl: source.directUrl,
    headers: source.headers,
    kind: "video",
  }));
}

function getBestDirectChoiceIndex(choices = []) {
  if (!Array.isArray(choices) || choices.length === 0) return -1;

  let bestIndex = 0;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const [index, choice] of choices.entries()) {
    const text = String(choice?.text || "");
    const height = Number(text.match(/(\d+)p/i)?.[1] || 0);
    let score = height * 100;

    if (/h265|hevc/i.test(text)) score += 10;
    if (/default/i.test(text)) score -= 1000;
    if (/direct/i.test(text)) score -= 500;

    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  return bestIndex;
}

function formatDouyinSourceLabel(video = {}) {
  const width = Number(video?.width || 0);
  const height = Number(video?.height || 0);
  const shortEdge = Math.min(width || 0, height || 0);
  if (shortEdge > 0) {
    return `${shortEdge}p`;
  }

  const firstUrl = Array.isArray(video?.play_addr?.url_list) ? video.play_addr.url_list[0] : null;
  if (typeof firstUrl === "string") {
    try {
      const ratio = new URL(firstUrl).searchParams.get("ratio");
      if (ratio) return ratio;
    } catch {
      // Ignore malformed URLs and fall back to a generic label.
    }
  }

  return "Default";
}

function normalizeDouyinPlayUrl(url) {
  if (typeof url !== "string" || !url.startsWith("http")) return null;
  return url.replace("/playwm/", "/play/");
}

function extractKuaishouSourcesFromHtml(html) {
  const sources = [];
  const seen = new Set();

  const addSource = (label, value) => {
    if (!value) return;
    const decoded = decodeEscapedUrl(value);
    if (!decoded.startsWith("http") || seen.has(decoded)) return;
    seen.add(decoded);
    sources.push({ label, directUrl: decoded });
  };

  const mainUrl = html.match(/"photoUrl":"([^"]+\.mp4[^"]*)"/i)?.[1];
  const h265Url = html.match(/"photoH265Url":"([^"]+\.mp4[^"]*)"/i)?.[1];

  addSource("Default", mainUrl);
  addSource("H265", h265Url);

  // Fallback: collect extra mp4 URLs if explicit fields are missing.
  if (sources.length === 0) {
    const matches = html.matchAll(/"url":"([^"]+\.mp4[^"]*)"/gi);
    for (const match of matches) {
      addSource("Default", match[1]);
      if (sources.length >= 2) break;
    }
  }

  return sources;
}

function buildKuaishouDirectHeaders(pageUrl) {
  return {
    ...KUAISHOU_MOBILE_HEADERS,
    Referer: pageUrl,
  };
}

function extractWindowJsonAssignment(html, variableName) {
  const marker = `${variableName} = `;
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`${variableName} assignment was not found in HTML.`);
  }

  const jsonStart = html.indexOf("{", markerIndex + marker.length);
  if (jsonStart < 0) {
    throw new Error(`${variableName} assignment does not contain a JSON object.`);
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = jsonStart; index < html.length; index += 1) {
    const char = html[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(html.slice(jsonStart, index + 1));
      }
    }
  }

  throw new Error(`${variableName} JSON block is incomplete.`);
}

function extractKuaishouIdentifiers(url) {
  const identifiers = new Set();
  const addIdentifier = (value) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length < 6) return;
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) return;
    identifiers.add(trimmed);
  };

  try {
    const parsed = new URL(url);
    for (const key of ["photoId", "shareObjectId", "shareToken"]) {
      addIdentifier(parsed.searchParams.get(key));
    }

    for (const segment of parsed.pathname.split("/")) {
      const lowered = segment.toLowerCase();
      if (!segment || ["fw", "photo", "short-video"].includes(lowered)) continue;
      addIdentifier(segment);
    }
  } catch {
    // Ignore malformed URLs and return best-effort identifiers.
  }

  return [...identifiers];
}

function flattenKuaishouManifestRepresentations(photo = {}) {
  const adaptationSet = Array.isArray(photo?.manifest?.adaptationSet)
    ? photo.manifest.adaptationSet
    : [];

  return adaptationSet.flatMap((item) =>
    Array.isArray(item?.representation) ? item.representation : []
  );
}

function formatKuaishouSourceLabel(representation = {}) {
  const qualityType = typeof representation?.qualityType === "string"
    ? representation.qualityType.trim()
    : "";
  if (/^\d+p$/i.test(qualityType)) {
    return qualityType.toLowerCase();
  }

  const shortEdge = Math.min(
    Number(representation?.height || 0),
    Number(representation?.width || 0)
  );
  if (shortEdge > 0) {
    return `${shortEdge}p`;
  }

  const qualityLabel = typeof representation?.qualityLabel === "string"
    ? representation.qualityLabel.trim()
    : "";
  if (qualityLabel) {
    return qualityLabel;
  }

  return "Default";
}

function collectKuaishouPhotoCandidates(initState) {
  const candidates = [];
  const stack = [initState];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;

    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }

    if (current.photo && typeof current.photo === "object") {
      candidates.push(current);
    }

    stack.push(...Object.values(current));
  }

  return candidates;
}

function scoreKuaishouPhotoCandidate(candidate, identifiers = []) {
  const photo = candidate?.photo;
  if (!photo || typeof photo !== "object") return Number.NEGATIVE_INFINITY;

  let score = 0;
  const shareInfo = typeof photo.share_info === "string" ? photo.share_info : "";
  const candidateIds = [
    photo.photoId,
    photo.id,
    photo.userEid,
  ].filter((value) => typeof value === "string");

  for (const identifier of identifiers) {
    if (candidateIds.includes(identifier)) score += 100;
    if (shareInfo.includes(identifier)) score += 140;
  }

  const repCount = flattenKuaishouManifestRepresentations(photo).length;
  score += repCount * 20;
  if (Array.isArray(photo?.mainMvUrls) && photo.mainMvUrls.length > 0) score += 40;
  if (Array.isArray(photo?.coverUrls) && photo.coverUrls.length > 0) score += 15;
  if (typeof photo?.caption === "string" && photo.caption.trim()) score += 10;
  if (typeof photo?.photoType === "string" && /video/i.test(photo.photoType)) score += 30;
  if (candidate?.result === 1) score += 10;

  return score;
}

function extractKuaishouSourcesFromMobileHtml(html, pageUrl) {
  const initState = extractWindowJsonAssignment(html, "window.INIT_STATE");
  const identifiers = extractKuaishouIdentifiers(pageUrl);
  const candidates = collectKuaishouPhotoCandidates(initState);

  if (candidates.length === 0) {
    throw new Error("Kuaishou mobile fallback could not find photo data in INIT_STATE.");
  }

  const bestCandidate = candidates
    .map((candidate) => ({
      candidate,
      score: scoreKuaishouPhotoCandidate(candidate, identifiers),
    }))
    .sort((a, b) => b.score - a.score)[0]?.candidate;

  const photo = bestCandidate?.photo;
  if (!photo || typeof photo !== "object") {
    throw new Error("Kuaishou mobile fallback did not locate a usable photo payload.");
  }

  const sources = [];
  const seen = new Set();
  const directHeaders = buildKuaishouDirectHeaders(pageUrl);
  const addSource = (label, value) => {
    if (!value) return;
    const decoded = decodeEscapedUrl(String(value));
    if (!decoded.startsWith("http") || seen.has(decoded)) return;
    seen.add(decoded);
    sources.push({ label, directUrl: decoded, headers: directHeaders });
  };

  for (const representation of flattenKuaishouManifestRepresentations(photo)) {
    const baseLabel = formatKuaishouSourceLabel(representation);
    const codecText = `${representation?.videoCodec || ""} ${representation?.codecs || ""}`;
    const codecSuffix = /(?:hevc|h265)/i.test(codecText) ? " H265" : "";
    addSource(`${baseLabel}${codecSuffix}`, representation?.url);
    addSource(`${baseLabel}${codecSuffix}`, Array.isArray(representation?.backupUrl)
      ? representation.backupUrl[0]
      : null);
  }

  for (const item of Array.isArray(photo?.mainMvUrls) ? photo.mainMvUrls : []) {
    addSource("Default", item?.url);
  }

  addSource("Default", photo?.photoUrl);
  addSource("H265", photo?.photoH265Url);

  if (sources.length === 0) {
    throw new Error("Kuaishou mobile fallback found the post but no playable video URL.");
  }

  const coverList = Array.isArray(photo?.coverUrls) ? photo.coverUrls : [];
  const thumbnailUrl = coverList.find((item) => typeof item?.url === "string")?.url ||
    (typeof photo?.headUrl === "string" ? photo.headUrl : null);

  return { sources, thumbnailUrl };
}

function pickMatchingDirectChoice(targetChoice, choices = []) {
  if (!targetChoice || !Array.isArray(choices) || choices.length === 0) return null;

  const normalizedText = String(targetChoice?.text || "").trim().toLowerCase();
  if (!normalizedText) return choices[0] || null;

  const exactMatch = choices.find(
    (choice) => String(choice?.text || "").trim().toLowerCase() === normalizedText
  );
  if (exactMatch) return exactMatch;

  const targetHeight = Number(normalizedText.match(/(\d+)p/i)?.[1] || 0);
  const targetWantsH265 = /h265|hevc/i.test(normalizedText);

  if (targetHeight > 0) {
    const sameHeightChoices = choices.filter((choice) =>
      Number(String(choice?.text || "").match(/(\d+)p/i)?.[1] || 0) === targetHeight
    );
    if (sameHeightChoices.length > 0) {
      const codecMatch = sameHeightChoices.find((choice) =>
        /h265|hevc/i.test(String(choice?.text || "")) === targetWantsH265
      );
      return codecMatch || sameHeightChoices[0];
    }
  }

  const codecMatch = choices.find((choice) =>
    /h265|hevc/i.test(String(choice?.text || "")) === targetWantsH265
  );
  return codecMatch || choices[getBestDirectChoiceIndex(choices)] || choices[0];
}

async function downloadKuaishouDirectFileWithRetry(selection, choice, filePath) {
  try {
    await downloadDirectFile(choice.directUrl, filePath, choice.headers);
  } catch (error) {
    if (!isKuaishouUrl(selection?.finalUrl)) {
      throw error;
    }

    log(`[fallback] Kuaishou direct download failed; refreshing source. ${error.message}`);
    const refreshed = await getKuaishouFallbackSources(selection.finalUrl);
    const refreshedChoices = mapDirectSourcesToChoices(refreshed.sources);
    const retryChoice = choice.kind === "audio"
      ? refreshedChoices[getBestDirectChoiceIndex(refreshedChoices)]
      : pickMatchingDirectChoice(choice, refreshedChoices);

    if (!retryChoice?.directUrl) {
      throw error;
    }

    await downloadDirectFile(retryChoice.directUrl, filePath, retryChoice.headers);
  }
}

function buildDouyinShareCandidates(inputUrl, finalUrl) {
  const candidates = [];
  const videoId = extractDouyinVideoId(finalUrl) || extractDouyinVideoId(inputUrl);

  if (videoId) {
    candidates.push(`https://www.iesdouyin.com/share/video/${videoId}/`);
  }

  for (const candidate of [inputUrl, finalUrl]) {
    if (!candidate) continue;
    if (isDouyinShortUrl(candidate) || isDouyinSharePageUrl(candidate)) {
      candidates.push(candidate);
    }
  }

  return [...new Set(candidates)];
}

function extractDouyinSourcesFromHtml(html) {
  const routerDataMatch = html.match(
    /window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/i
  );
  if (!routerDataMatch) {
    throw new Error("Douyin fallback could not find router data in share page.");
  }

  let routerData;
  try {
    routerData = JSON.parse(routerDataMatch[1]);
  } catch (error) {
    throw new Error(`Douyin fallback router data parse failed: ${error.message}`);
  }

  const loaderValues = Object.values(routerData?.loaderData || {});
  const pageData = loaderValues.find((entry) =>
    Array.isArray(entry?.videoInfoRes?.item_list)
  );
  const item = pageData?.videoInfoRes?.item_list?.find((entry) =>
    Array.isArray(entry?.video?.play_addr?.url_list) && entry.video.play_addr.url_list.length > 0
  );

  if (!item) {
    throw new Error("Douyin fallback page does not contain a playable video.");
  }

  const playUrls = item.video.play_addr.url_list
    .map((value) => normalizeDouyinPlayUrl(value))
    .filter((value, index, values) => value && values.indexOf(value) === index);

  if (playUrls.length === 0) {
    throw new Error("Douyin fallback could not extract a direct play URL.");
  }

  const label = formatDouyinSourceLabel(item.video);
  const sources = playUrls.map((directUrl) => ({
    label,
    directUrl,
    headers: DOUYIN_MOBILE_SHARE_HEADERS,
  }));

  const coverUrls = Array.isArray(item?.video?.cover?.url_list)
    ? item.video.cover.url_list.filter((value) => typeof value === "string" && value.startsWith("http"))
    : [];
  const thumbnailUrl = coverUrls.length > 0 ? coverUrls[coverUrls.length - 1] : null;

  return {
    sources,
    thumbnailUrl,
  };
}

async function getDouyinFallbackSources(inputUrl, finalUrl) {
  const candidates = buildDouyinShareCandidates(inputUrl, finalUrl);
  if (candidates.length === 0) {
    throw new Error("Douyin fallback could not determine a share page URL.");
  }

  let lastError = null;

  for (const candidateUrl of candidates) {
    try {
      log(`[fallback] Douyin page parse start: ${candidateUrl}`);
      const response = await axios({
        method: "GET",
        url: candidateUrl,
        timeout: REDIRECT_TIMEOUT_MS,
        maxRedirects: 10,
        headers: DOUYIN_MOBILE_SHARE_HEADERS,
        validateStatus: () => true,
      });

      if (response.status >= 400 || typeof response.data !== "string") {
        throw new Error(`Douyin fallback page fetch failed (status ${response.status}).`);
      }

      const extracted = extractDouyinSourcesFromHtml(response.data);
      log(`[fallback] Douyin play URL extracted (${extracted.sources.length} source(s)).`);
      return extracted;
    } catch (error) {
      lastError = error;
      log(`[fallback] Douyin candidate failed for ${candidateUrl}: ${error.message}`);
    }
  }

  throw lastError || new Error("Douyin fallback could not extract a playable video.");
}

async function downloadDirectFile(url, filePath, requestHeaders = undefined) {
  const response = await axios({
    method: "GET",
    url,
    responseType: "stream",
    timeout: 60000,
    headers: {
      ...RESOLVE_HEADERS,
      ...(requestHeaders || {}),
    },
    validateStatus: (status) => status >= 200 && status < 300,
  });

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(filePath);

    writer.on("finish", resolve);
    writer.on("error", reject);
    response.data.on("error", reject);

    response.data.pipe(writer);
  });
}

function getFfmpegBinary() {
  if (FFMPEG_LOCATION) {
    const lower = FFMPEG_LOCATION.toLowerCase();
    if (lower.endsWith(".exe") || lower.endsWith("/ffmpeg") || lower.endsWith("\\ffmpeg")) {
      return FFMPEG_LOCATION;
    }

    return path.join(
      FFMPEG_LOCATION,
      process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"
    );
  }

  return process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

async function extractAudioWithFfmpeg(inputPath, outputPath) {
  const ffmpegBinary = getFfmpegBinary();
  const args = [
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-acodec",
    "libmp3lame",
    "-b:a",
    "192k",
    outputPath,
  ];

  log(`[ffmpeg] Command: ${ffmpegBinary} ${args.join(" ")}`);

  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegBinary, args, {
      windowsHide: true,
    });

    let stderr = "";

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(`[ffmpeg] ${text}`);
    });

    child.on("error", (error) => {
      reject(new Error(`Failed to start ffmpeg process: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(`ffmpeg exited with code ${code}.\n${stderr || "No output"}`)
      );
    });
  });
}

async function getKuaishouFallbackSources(pageUrl) {
  let lastError = null;

  try {
    log(`[fallback] Kuaishou mobile page parse start: ${pageUrl}`);
    const mobileResponse = await axios({
      method: "GET",
      url: pageUrl,
      timeout: REDIRECT_TIMEOUT_MS,
      maxRedirects: 10,
      headers: KUAISHOU_MOBILE_HEADERS,
      validateStatus: () => true,
    });

    if (mobileResponse.status >= 400 || typeof mobileResponse.data !== "string") {
      throw new Error(`Kuaishou mobile page fetch failed (status ${mobileResponse.status}).`);
    }

    const finalMobileUrl = mobileResponse.request?.res?.responseUrl || pageUrl;
    const extracted = extractKuaishouSourcesFromMobileHtml(mobileResponse.data, finalMobileUrl);
    log(`[fallback] Kuaishou mobile sources extracted (${extracted.sources.length} source(s)).`);
    return extracted;
  } catch (error) {
    lastError = error;
    log(`[fallback] Kuaishou mobile parse failed: ${error.message}`);
  }

  try {
    log(`[fallback] Kuaishou desktop page parse start: ${pageUrl}`);
    const response = await axios({
      method: "GET",
      url: pageUrl,
      timeout: REDIRECT_TIMEOUT_MS,
      maxRedirects: 5,
      headers: RESOLVE_HEADERS,
      validateStatus: () => true,
    });

    if (response.status >= 400 || typeof response.data !== "string") {
      throw new Error(`Kuaishou fallback page fetch failed (status ${response.status}).`);
    }

    const sources = extractKuaishouSourcesFromHtml(response.data).map((source) => ({
      ...source,
      headers: buildKuaishouDirectHeaders(pageUrl),
    }));
    if (sources.length === 0) {
      throw new Error("Kuaishou fallback could not extract MP4 URL from page.");
    }

    const coverRaw = response.data.match(/"coverUrl":"([^"]+)"/i)?.[1];
    const thumbnailUrl = coverRaw ? decodeEscapedUrl(coverRaw) : null;

    log(`[fallback] Kuaishou desktop MP4 URL extracted (${sources.length} source(s)).`);
    return { sources, thumbnailUrl };
  } catch (error) {
    lastError = error;
    log(`[fallback] Kuaishou desktop parse failed: ${error.message}`);
  }

  throw lastError || new Error("Kuaishou fallback did not find a downloadable source.");
}

function shouldUseCookies(url) {
  if (!COOKIES_FROM_BROWSER || cookiesTemporarilyDisabled) return false;
  return /(facebook\.com|fb\.watch|instagram\.com|douyin\.com|iesdouyin\.com|tiktok\.com)/i.test(url);
}

function isCookieLoadError(errorText) {
  const text = errorText.toLowerCase();
  return (
    text.includes("could not copy chrome cookie database") ||
    text.includes("failed to decrypt with dpapi") ||
    text.includes("failed to decrypt cookies")
  );
}

function isDouyinFreshCookieError(errorText) {
  return /fresh cookies .* needed/i.test(errorText);
}

async function ensureDownloadDir() {
  await fsp.mkdir(DOWNLOAD_DIR, { recursive: true });
}

async function resolveFinalUrl(inputUrl) {
  log(`[resolve] Start: ${inputUrl}`);

  // Attempt 1: HEAD request with redirects
  try {
    const headResponse = await axios({
      method: "HEAD",
      url: inputUrl,
      maxRedirects: 10,
      timeout: REDIRECT_TIMEOUT_MS,
      validateStatus: () => true,
      headers: RESOLVE_HEADERS,
    });

    const finalUrl = headResponse.request?.res?.responseUrl || inputUrl;
    log(`[resolve] HEAD result: ${finalUrl} (status ${headResponse.status})`);
    return finalUrl;
  } catch (error) {
    log(`[resolve] HEAD failed: ${error.message}`);
  }

  // Attempt 2: GET request with stream to avoid loading full HTML into memory
  try {
    const getResponse = await axios({
      method: "GET",
      url: inputUrl,
      maxRedirects: 10,
      timeout: REDIRECT_TIMEOUT_MS,
      validateStatus: () => true,
      headers: RESOLVE_HEADERS,
      responseType: "stream",
    });

    const finalUrl = getResponse.request?.res?.responseUrl || inputUrl;
    getResponse.data.destroy();
    log(`[resolve] GET result: ${finalUrl} (status ${getResponse.status})`);
    return finalUrl;
  } catch (error) {
    log(`[resolve] GET failed, fallback to original URL: ${error.message}`);
    return inputUrl;
  }
}

function buildYtDlpArgs({
  url,
  includeCookies,
  outputTemplate = null,
  formatSelector = null,
  dumpJson = false,
  downloadMode = "video",
}) {
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--newline",
  ];

  if (YTDLP_JS_RUNTIMES && isYouTubeUrl(url)) {
    args.push("--js-runtimes", YTDLP_JS_RUNTIMES);
  }

  if (YTDLP_PROXY) {
    args.push("--proxy", YTDLP_PROXY);
  }

  if (dumpJson) {
    args.push("--dump-single-json");
  } else {
    if (downloadMode === "audio") {
      args.push(
        "-f",
        formatSelector || "bestaudio/best",
        "-x",
        "--audio-format",
        "mp3"
      );
    } else {
      args.push(
        "-f",
        formatSelector || "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best",
        "--merge-output-format",
        "mp4"
      );
    }
  }

  if (FFMPEG_LOCATION) {
    args.push("--ffmpeg-location", FFMPEG_LOCATION);
  }

  if (includeCookies && COOKIES_FROM_BROWSER) {
    args.push("--cookies-from-browser", COOKIES_FROM_BROWSER);
  }

  if (outputTemplate) {
    args.push("-o", outputTemplate);
  }

  args.push(url);
  return args;
}

function execYtDlp(args) {
  return new Promise((resolve, reject) => {
    log(`[yt-dlp] Command: ${YTDLP_PATH} ${args.join(" ")}`);

    const child = spawn(YTDLP_PATH, args, {
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(`[yt-dlp] ${text}`);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(`[yt-dlp] ${text}`);
    });

    child.on("error", (error) => {
      reject(new Error(`Failed to start yt-dlp process: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(
          `yt-dlp exited with code ${code}.\n${stderr || stdout || "No output"}`
        )
      );
    });
  });
}

async function runYtDlpInfo(url) {
  const includeCookies = shouldUseCookies(url);
  const args = buildYtDlpArgs({
    url,
    includeCookies,
    dumpJson: true,
  });

  const parseJson = (text) => {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first < 0 || last < 0 || last <= first) {
      const snippet = text
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500);
      throw new Error(
        `yt-dlp metadata parse failed. Output: ${snippet || "(empty output)"}`
      );
    }
    return JSON.parse(text.slice(first, last + 1));
  };

  try {
    const { stdout, stderr } = await execYtDlp(args);
    return parseJson(stdout || stderr || "");
  } catch (error) {
    const errorText = error?.message || String(error);
    if (includeCookies && isCookieLoadError(errorText)) {
      cookiesTemporarilyDisabled = true;
      log(
        `[yt-dlp] Cookies failed (${COOKIES_FROM_BROWSER}); retrying without cookies for this session.`
      );
      const retryArgs = buildYtDlpArgs({
        url,
        includeCookies: false,
        dumpJson: true,
      });
      const { stdout, stderr } = await execYtDlp(retryArgs);
      return parseJson(stdout || stderr || "");
    }
    throw error;
  }
}

async function runYtDlpInfoWithFallback(url) {
  const candidates = buildYtDlpCandidateUrls(url);
  let lastError = null;
  const failures = [];

  for (const candidateUrl of candidates) {
    try {
      const info = await runYtDlpInfo(candidateUrl);
      return { info, ytdlpUrl: candidateUrl };
    } catch (error) {
      lastError = error;
      const reason = error?.message || String(error);
      failures.push({ candidateUrl, reason });
      log(
        `[yt-dlp] Metadata attempt failed for ${candidateUrl}: ${
          reason
        }`
      );
    }
  }

  if (lastError) {
    const summary = failures
      .map((item) => `${item.candidateUrl} => ${item.reason}`)
      .join(" | ");
    throw new Error(`yt-dlp failed for all candidate URLs. ${summary}`);
  }
  throw new Error("yt-dlp metadata extraction failed for all candidate URLs.");
}

async function runYtDlpDownload(url, outputTemplate, formatSelector, downloadMode = "video") {
  const includeCookies = shouldUseCookies(url);
  const args = buildYtDlpArgs({
    url,
    includeCookies,
    outputTemplate,
    formatSelector,
    downloadMode,
  });

  try {
    return await execYtDlp(args);
  } catch (error) {
    const errorText = error?.message || String(error);
    if (includeCookies && isCookieLoadError(errorText)) {
      cookiesTemporarilyDisabled = true;
      log(
        `[yt-dlp] Cookies failed (${COOKIES_FROM_BROWSER}); retrying without cookies for this session.`
      );
      const retryArgs = buildYtDlpArgs({
        url,
        includeCookies: false,
        outputTemplate,
        formatSelector,
        downloadMode,
      });
      return execYtDlp(retryArgs);
    }
    throw error;
  }
}

async function findDownloadedFile(baseName, extensions) {
  const files = await fsp.readdir(DOWNLOAD_DIR);
  const normalizedExtensions = extensions.map((ext) => ext.toLowerCase());
  const candidates = files.filter((file) => {
    if (!file.startsWith(`${baseName}.`)) return false;
    const lower = file.toLowerCase();
    return normalizedExtensions.some((ext) => lower.endsWith(ext));
  });

  if (candidates.length === 0) {
    throw new Error("Download completed but expected media file was not found.");
  }

  // Pick newest file in case yt-dlp created more than one candidate.
  const withStats = await Promise.all(
    candidates.map(async (fileName) => {
      const fullPath = path.join(DOWNLOAD_DIR, fileName);
      const stat = await fsp.stat(fullPath);
      return { fullPath, mtimeMs: stat.mtimeMs };
    })
  );

  withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withStats[0].fullPath;
}

function buildFormatChoices(info) {
  const formats = Array.isArray(info?.formats) ? info.formats : [];
  const bestByHeight = new Map();

  for (const format of formats) {
    if (!format?.format_id) continue;
    if (!format.vcodec || format.vcodec === "none") continue;
    if (format.height && Number(format.height) > 0) {
      const key = Number(format.height);
      const current = bestByHeight.get(key);
      const hasAudio = Boolean(format.acodec && format.acodec !== "none");
      // Prefer formats that already include audio at the same height.
      const score = Number(format.tbr || 0) + (hasAudio ? 1_000_000 : 0);
      const currentScore = Number(current?.tbr || 0);
      if (!current || score > currentScore) {
        bestByHeight.set(key, {
          formatId: String(format.format_id),
          height: key,
          width: Number(format.width || 0),
          ext: String(format.ext || "mp4"),
          filesize: Number(format.filesize || format.filesize_approx || 0),
          tbr: score,
          hasAudio,
        });
      }
    }
  }

  const choices = [...bestByHeight.values()]
    .sort((a, b) => a.height - b.height)
    .slice(-8)
    .map((item) => {
      const sizeText = item.filesize > 0 ? ` ~${formatMb(item.filesize)}MB` : "";
      const formatSelector = item.hasAudio
        ? item.formatId
        : `${item.formatId}+ba[ext=m4a]/${item.formatId}+ba/bestaudio`;
      return {
        text: `${item.height}p${sizeText}`,
        formatSelector,
        kind: "video",
      };
    });

  return choices;
}

function extractPreviewImageUrl(info) {
  if (typeof info?.thumbnail === "string" && info.thumbnail.startsWith("http")) {
    return info.thumbnail;
  }

  if (Array.isArray(info?.thumbnails)) {
    const urls = info.thumbnails
      .map((item) => item?.url)
      .filter((url) => typeof url === "string" && url.startsWith("http"));
    if (urls.length > 0) {
      return urls[urls.length - 1];
    }
  }

  return null;
}

async function safeDelete(filePath) {
  if (!filePath) return;

  try {
    await fsp.unlink(filePath);
    log(`[cleanup] Deleted: ${filePath}`);
  } catch (error) {
    log(`[cleanup] Failed to delete ${filePath}: ${error.message}`);
  }
}

async function safeDeleteMessage(chatId, messageId) {
  if (!chatId || !messageId) return;

  try {
    await bot.deleteMessage(chatId, String(messageId));
  } catch (error) {
    log(`[delete-message-error] ${error?.message || String(error)}`);
  }
}

async function safeDeleteMessages(chatId, messageIds = []) {
  for (const messageId of messageIds) {
    await safeDeleteMessage(chatId, messageId);
  }
}

async function safeAnswerCallback(queryId, options = undefined) {
  try {
    if (options) {
      await bot.answerCallbackQuery(queryId, options);
    } else {
      await bot.answerCallbackQuery(queryId);
    }
  } catch (error) {
    log(`[callback-answer-error] ${error?.message || String(error)}`);
  }
}

async function handleSelectionDownload(
  chatId,
  selectionId,
  choiceIndex,
  overrideChoice = null,
  options = {}
) {
  const selection = pendingSelections.get(selectionId);
  if (!selection) {
    await bot.sendMessage(chatId, "This selection has expired. Send the link again.");
    return;
  }

  if (selection.chatId !== chatId) {
    await bot.sendMessage(chatId, "This selection belongs to another chat.");
    return;
  }

  const choice = overrideChoice || selection.choices[choiceIndex];
  if (!choice) {
    await bot.sendMessage(chatId, "Invalid quality option. Choose a number from the list.");
    return;
  }

  if (selection.downloading) {
    await bot.sendMessage(chatId, "A download is already in progress. Please wait.");
    return;
  }
  selection.downloading = true;

  let downloadedFilePath = "";
  const temporaryFilePaths = [];
  const resultReplyMarkup = options.replyMarkup ? { reply_markup: options.replyMarkup } : {};
  const cleanupMessageIds = Array.isArray(options.cleanupMessageIds)
    ? options.cleanupMessageIds.filter(Boolean)
    : [];
  let sentMediaMessage = null;

  try {
    if (!options.silent) {
      await bot.sendMessage(chatId, `Downloading ${choice.text}...`);
    }

    const sourceUrl = selection.ytdlpUrl || selection.finalUrl;

    const baseName = `video_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const outputTemplate = path.join(DOWNLOAD_DIR, `${baseName}.%(ext)s`);

    if (choice.kind === "origin") {
      await bot.sendMessage(chatId, `Origin URL:\n${selection.finalUrl}`);
      return;
    }

    if (choice.kind === "audio" && selection.sourceType === "direct" && choice.directUrl) {
      const sourceVideoPath = path.join(DOWNLOAD_DIR, `${baseName}.source.mp4`);
      downloadedFilePath = path.join(DOWNLOAD_DIR, `${baseName}.mp3`);
      temporaryFilePaths.push(sourceVideoPath);
      if (isKuaishouUrl(selection.finalUrl)) {
        await downloadKuaishouDirectFileWithRetry(selection, choice, sourceVideoPath);
      } else {
        await downloadDirectFile(choice.directUrl, sourceVideoPath, choice.headers);
      }
      await extractAudioWithFfmpeg(sourceVideoPath, downloadedFilePath);
    } else if (selection.sourceType === "direct" && choice.directUrl) {
      downloadedFilePath = path.join(DOWNLOAD_DIR, `${baseName}.mp4`);
      if (isKuaishouUrl(selection.finalUrl)) {
        await downloadKuaishouDirectFileWithRetry(selection, choice, downloadedFilePath);
      } else {
        await downloadDirectFile(choice.directUrl, downloadedFilePath, choice.headers);
      }
    } else if (choice.kind === "audio") {
      await runYtDlpDownload(
        sourceUrl,
        outputTemplate,
        choice.formatSelector || "bestaudio/best",
        "audio"
      );
      downloadedFilePath = await findDownloadedFile(baseName, [
        ".mp3",
        ".m4a",
        ".opus",
        ".webm",
        ".aac",
      ]);
    } else {
      await runYtDlpDownload(sourceUrl, outputTemplate, choice.formatSelector, "video");
      downloadedFilePath = await findDownloadedFile(baseName, [".mp4"]);
    }

    const stat = await fsp.stat(downloadedFilePath);
    log(
      `[file] path=${downloadedFilePath} size=${stat.size} bytes (${formatMb(stat.size)} MB)`
    );

    if (stat.size > MAX_DOWNLOAD_BYTES) {
      await bot.sendMessage(
        chatId,
        `This file is ${formatMb(stat.size)}MB. Configured max is ${MAX_DOWNLOAD_MB}MB.`
      );
      return;
    }

    if (stat.size > TELEGRAM_CLOUD_LIMIT_BYTES) {
      await bot.sendMessage(
        chatId,
        `File is ${formatMb(stat.size)}MB (>50MB). I will still try upload, but default Telegram cloud may reject it.`
      );
    }

    await bot.sendChatAction(chatId, choice.kind === "audio" ? "upload_audio" : "upload_video");

    try {
      if (choice.kind === "audio") {
        sentMediaMessage = await bot.sendAudio(chatId, downloadedFilePath, {
          ...resultReplyMarkup,
        });
      } else {
        sentMediaMessage = await bot.sendVideo(chatId, downloadedFilePath, {
          supports_streaming: true,
          ...resultReplyMarkup,
        });
      }
    } catch (videoError) {
      const videoErrorText = videoError?.message || String(videoError);
      log(`[sendVideo-error] ${videoErrorText}`);

      await bot.sendChatAction(chatId, "upload_document");
      sentMediaMessage = await bot.sendDocument(chatId, downloadedFilePath, {
        ...resultReplyMarkup,
      });
    }

    if (options.removeMessageId && sentMediaMessage?.message_id) {
      await safeDeleteMessage(chatId, options.removeMessageId);
    }

    log(`[send] Video sent to chat=${chatId}`);
  } catch (error) {
    const errorText = error?.stack || error?.message || String(error);
    log(`[error] ${errorText}`);
    await bot.sendMessage(chatId, getFriendlyErrorMessage(errorText));
  } finally {
    const latestSelection = pendingSelections.get(selectionId);
    if (latestSelection) {
      latestSelection.downloading = false;
    }

    if (!options.keepSelection) {
      cleanupSelection(selectionId);
    }
    await safeDeleteMessages(chatId, cleanupMessageIds);
    await safeDelete(downloadedFilePath);
    for (const filePath of temporaryFilePaths) {
      await safeDelete(filePath);
    }
  }
}

function getFriendlyErrorMessage(errorText) {
  const text = errorText.toLowerCase();

  if (text.includes("unsupported url")) {
    return "This link format is not currently supported by yt-dlp.";
  }

  if (text.includes("login required") || text.includes("registered users")) {
    return "This video requires login/cookies. Try a public video URL or configure cookies.";
  }

  if (text.includes("ffmpeg") && text.includes("not found")) {
    return "FFmpeg is missing. Install FFmpeg and set FFMPEG_LOCATION in .env if needed.";
  }

  if (
    text.includes("video unavailable") ||
    text.includes("private video") ||
    text.includes("this video is private") ||
    text.includes("this video is not available")
  ) {
    return "This video is unavailable, private, or region-restricted.";
  }

  if (text.includes("sign in to confirm you're not a bot")) {
    return "YouTube blocked this server IP. Try another link or use cookies/proxy.";
  }

  if (
    text.includes("unable to extract initial data") ||
    text.includes("failed to extract any player response")
  ) {
    return "YouTube blocked extraction from this server. Try another region/IP (YTDLP_PROXY).";
  }

  if (text.includes("no supported javascript runtime could be found")) {
    return "yt-dlp needs a JavaScript runtime for this YouTube link. Set YTDLP_JS_RUNTIMES=node.";
  }

  if (text.includes("unable to extract") || text.includes("extractor")) {
    return "Platform extraction failed. Update yt-dlp and try again.";
  }

  if (text.includes("file is too big") || text.includes("request entity too large")) {
    return "Telegram rejected this upload as too large. Use smaller quality or run local Bot API server.";
  }

  if (text.includes("request failed with status code 403")) {
    return "Direct media access was blocked or expired. Send the link again and retry.";
  }

  if (text.includes("request failed with status code 404")) {
    return "Direct media URL expired. Send the link again and retry.";
  }

  if (text.includes("timeout of") && text.includes("exceeded")) {
    return "Source download timed out. Try the link again.";
  }

  return "Failed to download this video. Check console logs for details.";
}

bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;
  const text =
    "Send a video URL (TikTok, Kuaishou, YouTube, Instagram, Facebook, etc.).\n" +
    `I will resolve short links, let you choose quality, then send MP4 (configured max ${MAX_DOWNLOAD_MB}MB). You can also paste multiple links in one message.`;

  await bot.sendMessage(chatId, text);
});

async function processIncomingUrl(chatId, extractedUrl, originalText) {
  const transientMessageIds = [];

  try {
    log(`[message] chat=${chatId} input=${originalText}`);
    log(`[message] extractedUrl=${extractedUrl}`);

    const resolvingMessage = await bot.sendMessage(chatId, "Resolving link...");
    transientMessageIds.push(resolvingMessage.message_id);
    const finalUrl = await resolveFinalUrl(extractedUrl);
    log(`[message] finalUrl=${finalUrl}`);
    const shouldTryKuaishouFallback = isKuaishouUrl(extractedUrl) || isKuaishouUrl(finalUrl);
    const shouldTryDouyinFallback = isDouyinUrl(extractedUrl) || isDouyinUrl(finalUrl);

    const checkingMessage = await bot.sendMessage(chatId, "Checking available qualities...");
    transientMessageIds.push(checkingMessage.message_id);

    let sourceType = "ytdlp";
    let choices = [];
    let previewImageUrl = null;
    let ytdlpUrl = finalUrl;

    try {
      const metadata = await runYtDlpInfoWithFallback(finalUrl);
      const info = metadata.info;
      ytdlpUrl = metadata.ytdlpUrl;
      choices = buildFormatChoices(info);
      previewImageUrl = extractPreviewImageUrl(info);

      if (choices.length === 0 && shouldTryKuaishouFallback) {
        log("[fallback] Triggered for Kuaishou URL with empty yt-dlp quality list.");
        const { sources, thumbnailUrl } = await getKuaishouFallbackSources(finalUrl);
        choices = mapDirectSourcesToChoices(sources);
        if (!previewImageUrl) {
          previewImageUrl = thumbnailUrl;
        }
        sourceType = "direct";
      }

      if (choices.length === 0 && shouldTryDouyinFallback) {
        log("[fallback] Triggered for Douyin URL with empty yt-dlp quality list.");
        const { sources, thumbnailUrl } = await getDouyinFallbackSources(extractedUrl, finalUrl);
        choices = mapDirectSourcesToChoices(sources);
        if (!previewImageUrl) {
          previewImageUrl = thumbnailUrl;
        }
        sourceType = "direct";
      }
    } catch (error) {
      const errorText = error?.stack || error?.message || String(error);
      if (isUnsupportedUrlError(errorText) && shouldTryKuaishouFallback) {
        if (isKuaishouShortVideoUrl(finalUrl)) {
          log("[fallback] Triggered for unsupported Kuaishou short-video URL.");
        } else {
          log("[fallback] Triggered for unsupported Kuaishou URL.");
        }
        const { sources, thumbnailUrl } = await getKuaishouFallbackSources(finalUrl);
        choices = mapDirectSourcesToChoices(sources);
        previewImageUrl = thumbnailUrl;
        sourceType = "direct";
      } else if (
        (isUnsupportedUrlError(errorText) || isDouyinFreshCookieError(errorText)) &&
        shouldTryDouyinFallback
      ) {
        log("[fallback] Triggered for Douyin URL after yt-dlp failure.");
        const { sources, thumbnailUrl } = await getDouyinFallbackSources(extractedUrl, finalUrl);
        choices = mapDirectSourcesToChoices(sources);
        previewImageUrl = thumbnailUrl;
        sourceType = "direct";
      } else {
        throw error;
      }
    }

    if (choices.length === 0) {
      await safeDeleteMessages(chatId, transientMessageIds);
      if (shouldTryKuaishouFallback) {
        await bot.sendMessage(
          chatId,
          "No downloadable video stream found for this Kuaishou link (it may be photo-only, private, or region-limited)."
        );
      } else if (shouldTryDouyinFallback) {
        await bot.sendMessage(
          chatId,
          "No downloadable video stream found for this Douyin link (it may be photo-only, private, or region-limited)."
        );
      } else {
        await bot.sendMessage(chatId, "No downloadable quality options found for this link.");
      }
      return;
    }

    const selectionId = crypto.randomBytes(5).toString("hex");
    const timer = setTimeout(() => cleanupSelection(selectionId), SELECTION_TTL_MS);
    if (typeof timer.unref === "function") timer.unref();
    const hdChoiceIndex = sourceType === "direct"
      ? getBestDirectChoiceIndex(choices)
      : choices.length - 1;
    const bestDirectChoice = sourceType === "direct" && hdChoiceIndex >= 0
      ? choices[hdChoiceIndex]
      : null;
    const audioChoice = sourceType === "ytdlp"
      ? {
        text: "Audio",
        kind: "audio",
        formatSelector: "bestaudio/best",
      }
      : bestDirectChoice?.directUrl
        ? {
          text: "Audio",
          kind: "audio",
          directUrl: bestDirectChoice.directUrl,
          headers: bestDirectChoice.headers,
        }
        : null;

    pendingSelections.set(selectionId, {
      chatId,
      finalUrl,
      ytdlpUrl: sourceType === "ytdlp" ? ytdlpUrl : finalUrl,
      sourceType,
      choices,
      hdChoiceIndex,
      audioChoice,
      downloading: false,
      timer,
    });
    activeSelectionByChat.set(chatId, selectionId);

    const inlineKeyboard = [];
    if (audioChoice) {
      inlineKeyboard.push([
        {
          text: "Audio",
          callback_data: `a:${selectionId}`,
        },
      ]);
    }
    inlineKeyboard.push([
      {
        text: `HD Download`,
        callback_data: `h:${selectionId}`,
      },
      {
        text: "Origin URL",
        url: finalUrl,
      },
    ]);

    const cardOptions = {
      reply_markup: {
        inline_keyboard: inlineKeyboard,
      },
    };

    let cardMessageId = null;
    let cardSent = false;
    if (previewImageUrl) {
      try {
        const sentCard = await bot.sendPhoto(chatId, previewImageUrl, cardOptions);
        cardMessageId = sentCard?.message_id || null;
        cardSent = true;
      } catch (previewError) {
        log(`[preview-error] ${previewError?.message || String(previewError)}`);
      }
    }

    if (!cardSent) {
      const sentCard = await bot.sendMessage(chatId, finalUrl, cardOptions);
      cardMessageId = sentCard?.message_id || null;
    }

    if (AUTO_DOWNLOAD) {
      const autoIndex = Number.isInteger(hdChoiceIndex) ? hdChoiceIndex : 0;
      await handleSelectionDownload(chatId, selectionId, autoIndex, null, {
        keepSelection: true,
        silent: true,
        replyMarkup: { inline_keyboard: inlineKeyboard },
        cleanupMessageIds: transientMessageIds,
        removeMessageId: cardMessageId,
      });
    } else {
      await safeDeleteMessages(chatId, transientMessageIds);
    }
  } catch (error) {
    const errorText = error?.stack || error?.message || String(error);
    log(`[error] ${errorText}`);
    await safeDeleteMessages(chatId, transientMessageIds);
    await bot.sendMessage(chatId, getFriendlyErrorMessage(errorText));
  }
}

bot.on("message", async (msg) => {
  if (!msg.text) return;
  if (msg.text.startsWith("/")) return;

  const chatId = msg.chat.id;
  const originalText = msg.text.trim();

  const extractedUrls = extractUrls(originalText);

  if (extractedUrls.length === 0) {
    await bot.sendMessage(chatId, "Please send a valid video URL.");
    return;
  }

  for (const extractedUrl of extractedUrls) {
    await processIncomingUrl(chatId, extractedUrl, originalText);
  }
});

bot.on("callback_query", async (query) => {
  const data = query.data || "";
  const chatId = query.message?.chat?.id;

  if (!chatId) {
    await safeAnswerCallback(query.id);
    return;
  }

  const [action, selectionId, indexRaw] = data.split(":");
  const selection = pendingSelections.get(selectionId);
  if (!selection) {
    await safeAnswerCallback(query.id, {
      text: "This selection expired. Send link again.",
      show_alert: true,
    });
    return;
  }

  await safeAnswerCallback(query.id);

  if (action === "o") {
    await bot.sendMessage(chatId, `Origin URL:\n${selection.finalUrl}`);
    return;
  }

  if (action === "h") {
    await handleSelectionDownload(chatId, selectionId, selection.hdChoiceIndex);
    return;
  }

  if (action === "a") {
    if (!selection.audioChoice) {
      await bot.sendMessage(chatId, "Audio option is not available for this link.");
      return;
    }
    await handleSelectionDownload(chatId, selectionId, -1, selection.audioChoice);
    return;
  }

  if (action === "q") {
    const choiceIndex = Number.parseInt(indexRaw, 10);
    if (Number.isNaN(choiceIndex)) {
      await bot.sendMessage(chatId, "Invalid quality option.");
      return;
    }
    await handleSelectionDownload(chatId, selectionId, choiceIndex);
    return;
  }

  await bot.sendMessage(chatId, "Unknown option.");
});

bot.on("polling_error", (error) => {
  log(`[polling_error] ${error?.message || String(error)}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

(async () => {
  await ensureDownloadDir();

  // Startup diagnostics
  log(`[startup] Bot started with polling.`);
  log(`[startup] YTDLP_PATH=${YTDLP_PATH}`);
  log(`[startup] FFMPEG_LOCATION=${FFMPEG_LOCATION || "(not set)"}`);
  log(`[startup] YTDLP_JS_RUNTIMES=${YTDLP_JS_RUNTIMES || "(not set)"}`);
  log(`[startup] YTDLP_PROXY=${YTDLP_PROXY ? "(set)" : "(not set)"}`);
  log(`[startup] COOKIES_FROM_BROWSER=${COOKIES_FROM_BROWSER || "(not set)"}`);
  log(`[startup] MAX_DOWNLOAD_MB=${MAX_DOWNLOAD_MB}`);
  log(`[startup] AUTO_DOWNLOAD=${AUTO_DOWNLOAD}`);

  // Helpful warning for Windows users when using local yt-dlp.exe path.
  if (
    process.platform === "win32" &&
    YTDLP_PATH.toLowerCase().endsWith(".exe") &&
    !fs.existsSync(YTDLP_PATH)
  ) {
    log(
      `[startup] Warning: yt-dlp executable not found at ${YTDLP_PATH}. ` +
      "Put yt-dlp.exe there or set YTDLP_PATH in .env."
    );
  }
})().catch((error) => {
  const errorText = error?.stack || error?.message || String(error);
  log(`[startup_error] ${errorText}`);
  process.exit(1);
});
