// Reddit extractor for Agent Browser Runtime.
// Feed URLs return thread summaries; thread URLs return post text + visible comments.
export const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: { type: 'string', enum: ['auto', 'feed', 'thread'], default: 'auto' },
    limit: { type: 'integer', default: 10 },
    sinceHours: { type: 'number' },
    maxFeedScrolls: { type: 'integer', default: 8 },
    expandComments: { type: 'boolean', default: true },
    maxCommentExpansionRounds: { type: 'integer', default: 8 },
    maxCommentExpansionClicks: { type: 'integer', default: 4 },
    includeHtmlLength: { type: 'boolean', default: false },
  },
};

const REDDIT_HOST_RE = /(^|\.)reddit\.com$/i;

export async function extract({ pageHtml, url, finalUrl, params = {}, ui }) {
  const targetUrl = normalizeRedditUrl(finalUrl || url);
  const config = normalizeParams(params);
  const mode = config.mode === 'auto' ? inferMode(targetUrl) : config.mode;
  const collectedAt = new Date().toISOString();

  if (mode === 'thread') {
    const html = config.expandComments
      ? await htmlAfterCommentExpansion(ui, pageHtml, config)
      : pageHtml;
    const thread = parseThread(html, targetUrl);
    return compactObject({
      source: 'reddit',
      kind: 'thread',
      collectedAt,
      url,
      finalUrl: targetUrl,
      ...thread,
      htmlLength: config.includeHtmlLength ? html.length : undefined,
    });
  }

  const feed = await collectFeed({ pageHtml, targetUrl, ui, config });
  return compactObject({
    source: 'reddit',
    kind: 'subreddit_feed',
    collectedAt,
    url,
    finalUrl: targetUrl,
    subreddit: inferSubreddit(targetUrl),
    limit: config.limit,
    sinceHours: config.sinceHours || null,
    threadCount: feed.threads.length,
    reachedCutoff: feed.reachedCutoff,
    threads: feed.threads,
    htmlLength: config.includeHtmlLength ? feed.htmlLength : undefined,
  });
}

async function collectFeed({ pageHtml, targetUrl, ui, config }) {
  const seen = new Map();
  let html = pageHtml || '';
  let reachedCutoff = false;
  let htmlLength = html.length;
  const cutoffMs = config.sinceHours ? Date.now() - config.sinceHours * 60 * 60 * 1000 : null;

  for (let attempt = 0; attempt <= config.maxFeedScrolls; attempt += 1) {
    const parsed = parseFeed(html, targetUrl, cutoffMs);
    reachedCutoff = reachedCutoff || parsed.reachedCutoff;
    for (const thread of parsed.threads) {
      if (!seen.has(thread.threadUrl)) {
        seen.set(thread.threadUrl, thread);
      }
    }
    if (seen.size >= config.limit || reachedCutoff || attempt === config.maxFeedScrolls) {
      break;
    }
    await ui?.scroll?.({ count: 2, deltaY: 650, pauseMs: 420 }).catch(() => {});
    const refreshed = await ui?.html?.({ timeoutMs: 30000 }).catch(() => null);
    html = refreshed?.html || html;
    htmlLength = html.length;
  }

  return {
    reachedCutoff,
    htmlLength,
    threads: Array.from(seen.values()).slice(0, config.limit),
  };
}

async function htmlAfterCommentExpansion(ui, initialHtml, config) {
  if (!ui) {
    return initialHtml || '';
  }

  let html = initialHtml || '';
  const targets = [
    'View more comments',
    'View more replies',
    'more replies',
    'Load more comments',
  ];
  let clicks = 0;

  for (let round = 0; round < config.maxCommentExpansionRounds; round += 1) {
    let roundClicks = 0;
    for (const targetText of targets) {
      if (roundClicks >= config.maxCommentExpansionClicks) {
        break;
      }
      const target = await ui.waitFor?.({ targetText, timeoutMs: 900, pollMs: 150 }).catch(() => null);
      if (!target?.found) {
        continue;
      }
      const clicked = await ui.click?.({ targetText, holdMs: 55, pauseAfterMs: 650 }).catch(() => null);
      if (clicked?.ok) {
        clicks += 1;
        roundClicks += 1;
      }
    }
    if (roundClicks === 0) {
      break;
    }
    await ui.scroll?.({ count: 1, deltaY: 260, pauseMs: 300 }).catch(() => {});
    const refreshed = await ui.html?.({ timeoutMs: 30000 }).catch(() => null);
    html = refreshed?.html || html;
  }

  const refreshed = await ui.html?.({ timeoutMs: 30000 }).catch(() => null);
  html = refreshed?.html || html;
  return html.replace('</body>', `<template data-reddit-expansion-clicks="${clicks}"></template></body>`);
}

function parseFeed(html, baseUrl, cutoffMs) {
  const threads = [];
  const seen = new Set();
  let reachedCutoff = false;

  for (const post of findElements(html, 'shreddit-post')) {
    const permalink = post.attrs.permalink || findFirstHref(post.inner, /\/comments\//i);
    if (!permalink) {
      continue;
    }
    const threadUrl = normalizeRedditUrl(permalink, baseUrl);
    if (seen.has(threadUrl)) {
      continue;
    }
    const createdAt = firstValue(post.attrs['created-timestamp'], post.attrs.createdtimestamp, post.attrs['created-at'], post.attrs.created);
    const createdAtMs = Date.parse(createdAt || '');
    if (cutoffMs && Number.isFinite(createdAtMs) && createdAtMs < cutoffMs) {
      reachedCutoff = true;
      continue;
    }
    seen.add(threadUrl);
    threads.push(compactObject({
      id: inferThreadId(threadUrl),
      subreddit: inferSubreddit(threadUrl),
      title: cleanText(post.attrs['post-title'] || extractHeadingText(post.inner)),
      threadUrl,
      createdAt: createdAt || null,
      score: parseNullableNumber(firstValue(post.attrs.score, post.attrs['upvote-count'], post.attrs.upvotes)),
      commentCount: parseNullableNumber(firstValue(post.attrs['comment-count'], post.attrs.comments)),
    }));
  }

  for (const anchor of findAnchors(html, /\/comments\//i)) {
    const threadUrl = normalizeRedditUrl(anchor.href, baseUrl);
    if (seen.has(threadUrl)) {
      continue;
    }
    seen.add(threadUrl);
    threads.push(compactObject({
      id: inferThreadId(threadUrl),
      subreddit: inferSubreddit(threadUrl),
      title: cleanText(anchor.text),
      threadUrl,
    }));
  }

  return { threads, reachedCutoff };
}

function parseThread(html, targetUrl) {
  const post = findElements(html, 'shreddit-post')[0] || { attrs: {}, inner: html };
  const comments = findElements(html, 'shreddit-comment')
    .map((comment, index) => parseComment(comment, index, targetUrl))
    .filter((comment) => comment.bodyText);
  const expansionClicks = Number(html.match(/data-reddit-expansion-clicks="(\d+)"/)?.[1] || 0);

  return {
    id: inferThreadId(targetUrl),
    subreddit: inferSubreddit(targetUrl),
    threadUrl: targetUrl,
    title: cleanText(post.attrs['post-title'] || extractHeadingText(html) || 'untitled reddit thread'),
    bodyText: cleanRedditText(extractPostBody(post.inner)),
    comments,
    metadata: compactObject({
      score: parseNullableNumber(firstValue(post.attrs.score, post.attrs['upvote-count'], post.attrs.upvotes)),
      upvoteCount: parseNullableNumber(firstValue(post.attrs['upvote-count'], post.attrs.upvotes, post.attrs.score)),
      commentCount: comments.length,
      createdAt: firstValue(post.attrs['created-timestamp'], post.attrs.createdtimestamp, post.attrs['created-at'], post.attrs.created) || null,
      commentCollectionStatus: expansionClicks > 0 ? 'expanded_visible_comments' : 'visible_comments_only',
      commentExpansionClicks: expansionClicks,
    }),
  };
}

function parseComment(comment, index, baseUrl) {
  const permalink = firstValue(comment.attrs.permalink, comment.attrs['data-permalink']);
  return compactObject({
    id: firstValue(comment.attrs.thingid, comment.attrs['data-comment-id'], comment.attrs.id) || `comment_${index + 1}`,
    parentId: normalizeParentId(firstValue(comment.attrs.parentid, comment.attrs['parent-id'], comment.attrs['data-parent-id'], comment.attrs.parent)),
    bodyText: cleanRedditText(extractCommentBody(comment.inner)),
    score: parseNullableNumber(firstValue(comment.attrs.score, comment.attrs['data-score'])),
    depth: parseNullableNumber(firstValue(comment.attrs.depth, comment.attrs['data-depth'])),
    createdAt: firstValue(comment.attrs['created-timestamp'], comment.attrs.createdtimestamp, comment.attrs['created-at'], comment.attrs.created) || null,
    author: firstValue(comment.attrs.author, comment.attrs['data-author']) || null,
    permalink: permalink ? normalizeRedditUrl(permalink, baseUrl) : null,
  });
}

function findElements(html, tagName) {
  const out = [];
  const re = new RegExp(`<${tagName}\\b([^>]*)>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  let match;
  while ((match = re.exec(html || ''))) {
    out.push({
      attrs: parseAttrs(match[1] || ''),
      inner: match[2] || '',
    });
  }
  return out;
}

function findAnchors(html, hrefPattern) {
  const out = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(html || ''))) {
    const attrs = parseAttrs(match[1] || '');
    if (!attrs.href || !hrefPattern.test(attrs.href)) {
      continue;
    }
    out.push({ href: attrs.href, text: stripTags(match[2] || '') });
  }
  return out;
}

function findFirstHref(html, hrefPattern) {
  return findAnchors(html, hrefPattern)[0]?.href || null;
}

function parseAttrs(source) {
  const attrs = {};
  const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = re.exec(source || ''))) {
    const key = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attrs[key] = decodeHtml(value);
  }
  return attrs;
}

function extractHeadingText(html) {
  return stripTags(firstTagInner(html, 'h1') || firstTagInner(html, 'h2') || firstTagInner(html, 'h3') || '');
}

function extractPostBody(html) {
  return stripTags(
    firstSlotInner(html, 'text-body')
    || firstIdContainsInner(html, 'post-rtjson-content')
    || firstClassInner(html, 'md')
    || '',
  );
}

function extractCommentBody(html) {
  return stripTags(
    firstSlotInner(html, 'comment')
    || firstIdContainsInner(html, 'comment-rtjson-content')
    || firstClassInner(html, 'md')
    || firstTagInner(html, 'p')
    || html,
  );
}

function firstSlotInner(html, slot) {
  const escaped = escapeRegExp(slot);
  const re = new RegExp(`<([A-Za-z0-9-]+)\\b(?=[^>]*\\bslot=["']${escaped}["'])[^>]*>([\\s\\S]*?)<\\/\\1>`, 'i');
  return html?.match(re)?.[2] || '';
}

function firstIdContainsInner(html, needle) {
  const escaped = escapeRegExp(needle);
  const re = new RegExp(`<([A-Za-z0-9-]+)\\b(?=[^>]*\\bid=["'][^"']*${escaped}[^"']*["'])[^>]*>([\\s\\S]*?)<\\/\\1>`, 'i');
  return html?.match(re)?.[2] || '';
}

function firstClassInner(html, className) {
  const escaped = escapeRegExp(className);
  const re = new RegExp(`<([A-Za-z0-9-]+)\\b(?=[^>]*\\bclass=["'][^"']*(^|\\s)${escaped}(\\s|$)[^"']*["'])[^>]*>([\\s\\S]*?)<\\/\\1>`, 'i');
  return html?.match(re)?.[4] || '';
}

function firstTagInner(html, tagName) {
  const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  return html?.match(re)?.[1] || '';
}

function stripTags(value) {
  return decodeHtml(String(value || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<template\b[\s\S]*?<\/template>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' '));
}

function cleanRedditText(value) {
  const withoutLoaders = String(value || '')
    .replace(/SML\.load\(\[[\s\S]*?\]\)\s*/g, '\n')
    .replace(/SML\.load\([^)]*\)\s*/g, '\n');
  return withoutLoaders
    .split(/\r?\n/)
    .map(cleanText)
    .filter(Boolean)
    .filter((line) => !isRedditUiLine(line))
    .join(' ')
    .replace(/\s+Read more$/i, '')
    .trim();
}

function cleanText(value) {
  return decodeHtml(String(value || '')).replace(/\s+/g, ' ').trim();
}

function isRedditUiLine(value) {
  return [
    'reply',
    'share',
    'award',
    'more replies',
    'view more comments',
    'load more comments',
    'read more',
    'upvote',
    'downvote',
  ].includes(cleanText(value).toLowerCase());
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function normalizeRedditUrl(value, baseUrl = 'https://www.reddit.com/') {
  const parsed = new URL(decodeHtml(value || ''), baseUrl);
  const host = parsed.hostname.replace(/^www\./i, '');
  if (!REDDIT_HOST_RE.test(host)) {
    throw new Error(`unexpected reddit host: ${parsed.hostname}`);
  }
  parsed.hash = '';
  return parsed.toString();
}

function inferMode(urlValue) {
  return new URL(urlValue).pathname.includes('/comments/') ? 'thread' : 'feed';
}

function inferThreadId(urlValue) {
  return String(urlValue || '').match(/\/comments\/([^/?#]+)/)?.[1] || null;
}

function inferSubreddit(urlValue) {
  return String(urlValue || '').match(/\/r\/([^/?#]+)/i)?.[1] || null;
}

function normalizeParentId(value) {
  const normalized = cleanText(value);
  if (!normalized || normalized === '0' || /^t3_/i.test(normalized)) {
    return null;
  }
  return normalized;
}

function parseNullableNumber(value) {
  if (value == null || value === '') {
    return null;
  }
  const normalized = String(value).replace(/,/g, '').trim().toLowerCase();
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    return null;
  }
  const multiplier = normalized.includes('k') ? 1000 : normalized.includes('m') ? 1000000 : 1;
  return Number(match[0]) * multiplier;
}

function normalizeParams(params) {
  return {
    mode: params.mode || 'auto',
    limit: clampInt(params.limit, 1, 100, 10),
    sinceHours: Number.isFinite(Number(params.sinceHours)) ? Number(params.sinceHours) : null,
    maxFeedScrolls: clampInt(params.maxFeedScrolls, 0, 100, 8),
    expandComments: params.expandComments !== false,
    maxCommentExpansionRounds: clampInt(params.maxCommentExpansionRounds, 0, 100, 8),
    maxCommentExpansionClicks: clampInt(params.maxCommentExpansionClicks, 0, 20, 4),
    includeHtmlLength: Boolean(params.includeHtmlLength),
  };
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function firstValue(...values) {
  return values.find((value) => value != null && String(value).trim()) || '';
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
