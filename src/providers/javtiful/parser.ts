import * as cheerio from 'cheerio';

export interface JavMetadata {
  code: string;
  title: string;
  description: string;
  thumbnailUrl: string | null;
  duration: string | null;
  date: string | null;
  actresses: string[];
  studio: string | null;
  genres: string[];
  sourceUrl: string;
}

function cleanText(value: string | undefined | null): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(cleanText).filter(Boolean))];
}

function absoluteUrl(value: string | undefined | null, pageUrl: string): string | null {
  const raw = cleanText(value);
  if (!raw) return null;
  try {
    const url = new URL(raw, pageUrl);
    if (!/^https?:$/i.test(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

function pageMatchesExpectedCode($: cheerio.CheerioAPI, pageUrl: string, expectedCode: string): boolean {
  const normalizedExpected = expectedCode.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!normalizedExpected) return false;

  const focusedText = [
    pageUrl,
    $('h1').first().text(),
    $('title').first().text(),
    $('meta[property="og:title"]').attr('content'),
    $('meta[name="description"]').attr('content'),
    $('meta[property="og:description"]').attr('content'),
  ]
    .map(value => cleanText(value))
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

  return focusedText.includes(normalizedExpected);
}

function extractLabeledValue($: cheerio.CheerioAPI, labels: string[]): string | null {
  const wanted = labels.map(label => label.toLowerCase());
  let result: string | null = null;

  $('dt, th, .label, .meta-label, .detail-label, .field-label, p, div, span, li').each((_, el) => {
    if (result) return;

    const text = cleanText($(el).text());
    if (!text || text.length > 180) return;

    const lower = text.toLowerCase();
    const label = wanted.find(item =>
      lower === item || lower.startsWith(item + ':') || lower.startsWith(item + ' ')
    );
    if (!label) return;

    const inlineValue = text.replace(
      new RegExp('^' + escapeRegex(label) + '\\s*[:\\-]?\\s*', 'i'),
      '',
    ).trim();

    if (inlineValue && inlineValue.toLowerCase() !== label) {
      result = inlineValue;
      return;
    }

    const sibling = cleanText($(el).next().text());
    if (sibling) {
      result = sibling;
      return;
    }

    const parentText = cleanText($(el).parent().text());
    const match = parentText.match(
      new RegExp(escapeRegex(label) + '\\s*[:\\-]\\s*(.+)$', 'i'),
    );
    if (match?.[1]) result = cleanText(match[1]);
  });

  return result;
}

/**
 * Extracts video page URLs from Javtiful search results HTML.
 */
export function parseSearchResults(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const results: string[] = [];

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && (href.includes('/video/') || href.includes('/v/'))) {
      const fullUrl = href.startsWith('http') ? href : new URL(href, baseUrl).toString();
      if (!results.includes(fullUrl)) results.push(fullUrl);
    }
  });

  return results;
}

/**
 * Parses a Javtiful video detail page into JavMetadata.
 *
 * SECURITY RULE:
 * Never return HLS, MP4, player, CDN, stream-token, or download URLs.
 * Only public page URLs and image URLs are retained.
 */
export function parseVideoPage(html: string, pageUrl: string, expectedCode: string): JavMetadata {
  const $ = cheerio.load(html);

  if (!pageMatchesExpectedCode($, pageUrl, expectedCode)) {
    throw new Error(`Javtiful page does not match requested code ${expectedCode}: ${pageUrl}`);
  }

  let title = cleanText(
    $('h1').first().text() ||
    $('meta[property="og:title"]').attr('content') ||
    $('title').text(),
  );
  title = title.replace(/\s*[-–|]\s*Javtiful.*$/i, '').trim();

  const description = cleanText(
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    $('.description, .video-description, #description, [class*="description"]').first().text(),
  );

  let thumbnailUrl =
    absoluteUrl($('meta[property="og:image"]').attr('content'), pageUrl) ||
    absoluteUrl($('meta[name="twitter:image"]').attr('content'), pageUrl) ||
    absoluteUrl($('video').first().attr('poster'), pageUrl) ||
    absoluteUrl($('.cover img, .poster img, .thumbnail img, .player img').first().attr('src'), pageUrl);

  if (!thumbnailUrl) {
    $('script[type="application/ld+json"]').each((_, el) => {
      if (thumbnailUrl) return;
      try {
        const raw = JSON.parse($(el).contents().text());
        const items = Array.isArray(raw) ? raw : [raw];

        for (const item of items) {
          const image = item?.image;
          const candidate = Array.isArray(image)
            ? image[0]
            : typeof image === 'object'
              ? image?.url
              : image;

          const resolved = absoluteUrl(candidate, pageUrl);
          if (resolved && /\.(?:jpe?g|png|webp)(?:[?#].*)?$/i.test(resolved)) {
            thumbnailUrl = resolved;
            break;
          }
        }
      } catch {
        // Ignore malformed JSON-LD.
      }
    });
  }

  const actresses: string[] = [];
  // Only accept links that explicitly point to an actress/star/model route.
  // Do not use broad class selectors here: Javtiful's actress section can
  // contain related-video cards, quality labels, and durations.
  $(
    'a[href*="/actress/"], a[href*="/actresses/"], ' +
    'a[href*="/star/"], a[href*="/stars/"], ' +
    'a[href*="/model/"], a[href*="/models/"]',
  ).each((_, el) => {
    const name = cleanText($(el).text());
    if (name && name.length <= 100) actresses.push(name);
  });

  let studio: string | null = extractLabeledValue(
    $,
    ['Studio', 'Maker', 'Production', 'Publisher'],
  );

  if (!studio) {
    $(
      'a[href*="/studio/"], a[href*="/studios/"]',
    ).each((_, el) => {
      if (!studio) {
        const name = cleanText($(el).text());
        if (name && name.length <= 150) studio = name;
      }
    });
  }

  const genres: string[] = [];
  $(
    'a[href*="/genre/"], a[href*="/genres/"]',
  ).each((_, el) => {
    const value = cleanText($(el).text());
    if (value && value.length <= 80) genres.push(value);
  });

  let duration = extractLabeledValue($, ['Duration', 'Length', 'Runtime']);

  if (!duration) {
    const durationMatch = $('body').text().match(
      /(?:Duration|Length|Runtime)\s*[:\-]?\s*([0-9]{1,3}:?[0-9]{2}(?::[0-9]{2})?|[0-9]{1,3}\s*(?:min|mins|minutes|hr|hrs|hours|分))/i,
    );
    duration = durationMatch?.[1] ? cleanText(durationMatch[1]) : null;
  }

  if (!duration) {
    duration = cleanText($('.duration, .time, .runtime, .badge-duration').first().text()) || null;
  }

  let date = extractLabeledValue($, ['Release Date', 'Release', 'Published', 'Date']);

  if (!date) {
    date = cleanText($('time[datetime]').first().attr('datetime')) || null;
  }

  if (!date) {
    const dateText = cleanText($('.date, .release-date, .published, time').first().text());
    if (dateText && /\d{4}/.test(dateText)) date = dateText;
  }

  return {
    code: expectedCode,
    title: title || expectedCode + ' Video',
    description: description.slice(0, 2000),
    thumbnailUrl,
    duration,
    date,
    actresses: uniqueStrings(actresses),
    studio: studio ? cleanText(studio) : null,
    genres: uniqueStrings(genres),
    sourceUrl: pageUrl,
  };
}
