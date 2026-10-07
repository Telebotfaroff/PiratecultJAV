import * as cheerio from 'cheerio';

export interface JavMetadata {
  code: string;
  title: string;
  description: string;
  thumbnailUrl: string | null;
  duration: string | null;
  date: string | null;
  actresses: string[];
  sourceUrl: string;
}

/**
 * Extracts video page URLs from Javtiful search results HTML
 */
export function parseSearchResults(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const results: string[] = [];

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && (href.includes('/video/') || href.includes('/v/'))) {
      const fullUrl = href.startsWith('http') ? href : `${baseUrl}${href.startsWith('/') ? '' : '/'}${href}`;
      if (!results.includes(fullUrl)) {
        results.push(fullUrl);
      }
    }
  });

  return results;
}

/**
 * Parses a Javtiful video detail page into JavMetadata.
 * STRICT NON-NEGOTIABLE RULE:
 * Absolutely NO HLS, MP4, stream URLs, CDN stream tokens, or download URLs.
 */
export function parseVideoPage(html: string, pageUrl: string, expectedCode: string): JavMetadata {
  const $ = cheerio.load(html);

  // 1. Extract Title
  let title = $('h1').first().text().trim();
  if (!title) {
    title = $('meta[property="og:title"]').attr('content') || $('title').text().trim();
  }
  // Clean up title suffixes like " - Javtiful"
  title = title.replace(/\s*[-–|]\s*Javtiful.*$/i, '').trim();

  // 2. Extract Description
  let description = $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    $('.description, .video-description, #description').text().trim() ||
    '';

  // 3. Extract Thumbnail Cover URL (web image only)
  let thumbnailUrl = $('meta[property="og:image"]').attr('content') ||
    $('meta[name="twitter:image"]').attr('content') ||
    $('video').attr('poster') ||
    $('.cover img, .poster img, .player img').first().attr('src') ||
    null;

  if (thumbnailUrl && !thumbnailUrl.startsWith('http')) {
    const base = new URL(pageUrl).origin;
    thumbnailUrl = `${base}${thumbnailUrl.startsWith('/') ? '' : '/'}${thumbnailUrl}`;
  }

  // 4. Extract Actresses
  const actresses: string[] = [];
  $('a[href*="/actress/"], a[href*="/star/"], a[href*="/model/"], .actress a, .models a').each((_, el) => {
    const name = $(el).text().trim();
    if (name && !actresses.includes(name)) {
      actresses.push(name);
    }
  });

  // 5. Extract Duration
  let duration: string | null = null;
  const durationMatch = html.match(/(?:Duration|Length)[:\s]*([0-9]{1,3}\s*(?:min|mins|分|hr|hours)?|[0-9]{1,2}:[0-9]{2}:[0-9]{2})/i);
  if (durationMatch) {
    duration = durationMatch[1].trim();
  } else {
    const badgeText = $('.duration, .time, .badge-duration').first().text().trim();
    if (badgeText) duration = badgeText;
  }

  // 6. Extract Release Date
  let date: string | null = null;
  const dateMatch = html.match(/(?:Release Date|Published|Date)[:\s]*([0-9]{4}[-/][0-9]{2}[-/][0-9]{2})/i);
  if (dateMatch) {
    date = dateMatch[1];
  } else {
    const dateText = $('.date, .release-date, time').first().text().trim();
    if (dateText && /\d{4}/.test(dateText)) date = dateText;
  }

  return {
    code: expectedCode,
    title: title || `${expectedCode} Video`,
    description: description.slice(0, 1000),
    thumbnailUrl,
    duration,
    date,
    actresses,
    sourceUrl: pageUrl,
  };
}
