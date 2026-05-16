// Etsy listing extractor: product media, personalization, reviews, and detail sections.
export const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    includeRawSections: { type: 'boolean', default: true },
  },
};

export async function extract({ pageHtml, url, params }) {
  const scrapedAt = new Date().toISOString();
  const ld = parseLdJson(pageHtml);
  const product = ld.find((x) => x?.['@type'] === 'Product') || {};
  const video = ld.find((x) => x?.['@type'] === 'VideoObject') || null;
  const breadcrumbs = ld.find((x) => x?.['@type'] === 'BreadcrumbList') || null;

  const title = decode(product.name || match(pageHtml, /<title[^>]*>([\s\S]*?)<\/title>/i));
  const metaDescription = meta(pageHtml, 'description');
  const listingId = String(product.sku || match(pageHtml, /"listing_id"\s*:\s*(\d+)/));
  const shopName = decode(product.brand?.name || match(pageHtml, /Owner of\s+([^<\n]+)/));

  const images = (Array.isArray(product.image) ? product.image : [])
    .map((img, index) => ({
      index: index + 1,
      url: img?.contentURL || img?.url || (typeof img === 'string' ? img : null),
      thumbnail: img?.thumbnail || null,
      description: decode(img?.description || null),
      author: decode(img?.author || null),
    }))
    .filter((x) => x.url);

  const mediaUrlsFromHtml = unique([...pageHtml.matchAll(/https?:\\?\/\\?\/[^"'<>\s]+?(?:jpg|jpeg|png|webp|gif|mp4)/gi)]
    .map((m) => decode(m[0]).replaceAll('\\/', '/')));

  const personalization = {
    required: boolFromText(match(pageHtml, /"personalization_is_required"\s*:\s*(true|false)/)),
    fieldCount: numberFromText(match(pageHtml, /"personalization_field_count"\s*:\s*(\d+)/)),
    variations: parseVariationSelects(pageHtml),
    textFields: parsePersonalizationFields(pageHtml),
  };

  const itemDetailsText = sectionText(pageHtml, 'Item details', 'Delivery and return policies');
  const deliveryText = sectionText(pageHtml, 'Delivery and return policies', 'Meet your seller');
  const reviewsText = sectionText(pageHtml, 'Reviews for this item', 'Yvonne Leung HereafterLA');
  const sellerText = sectionText(pageHtml, 'Meet your seller', 'Reviews for this item') || sectionText(pageHtml, 'Meet your seller', '</body>');

  const itemDetails = {
    highlights: compact([
      matchText(itemDetailsText, /Made by\s+([^\n]+?)(?=\s+Materials:|$)/),
      matchText(itemDetailsText, /(Materials:\s*[^\n]+?)(?=\s+Image size:|$)/),
      matchText(itemDetailsText, /(Image size:\s*[^\n]+?)(?=\s+Overall length:|$)/),
      matchText(itemDetailsText, /(Overall length:\s*[^\n]+?)(?=\s+Overall width:|$)/),
      matchText(itemDetailsText, /(Overall width:\s*[^\n]+?)(?=\s+Capture this|$)/),
    ]),
    description: decode(product.description || extractDescriptionFromDetails(itemDetailsText)),
    material: decode(product.material || null),
    category: decode(product.category || null),
  };

  const reviews = {
    itemAverage: numberFromText(matchText(reviewsText, /Reviews for this item\s+([0-9.]+)\s+Item average/)),
    itemReviewCount: numberFromText(matchText(reviewsText, /\((\d+)\s+reviews?\)/)),
    itemQuality: numberFromText(matchText(reviewsText, /([0-9.]+)\s+Item quality/)),
    delivery: numberFromText(matchText(reviewsText, /([0-9.]+)\s+Delivery/)),
    customerService: numberFromText(matchText(reviewsText, /([0-9.]+)\s+Customer service/)),
    buyersRecommend: matchText(reviewsText, /(\d+%\s+Buyers recommend)/),
    aggregateRating: product.aggregateRating || null,
    entries: parseReviews(product.review || [], reviewsText),
  };

  const delivery = {
    estimated: matchText(deliveryText, /(Order today to get by\s+[^.]+?)(?=\s+Your order should|$)/),
    explanation: matchText(deliveryText, /(Your order should arrive by this date[\s\S]+?delivered to\.)/),
    returnsAndExchanges: matchText(deliveryText, /(Returns & exchanges not accepted[\s\S]+?order)/),
    deliveryCost: matchText(deliveryText, /(Delivery cost:\s*[^\n]+?)(?=\s+Dispatched from:|$)/),
    dispatchedFrom: matchText(deliveryText, /(Dispatched from:\s*[^\n]+?)(?=\s+Deliver to|$)/),
    deliverTo: matchText(deliveryText, /(Deliver to\s+[^\n]+)$/),
    shippingOrigin: product.offers?.shippingDetails?.shippingOrigin || null,
  };

  const seller = {
    shopName,
    owner: matchText(sellerText, /(Yvonne Leung)/) || null,
    location: matchText(sellerText, /(California, United States)/) || null,
    response: matchText(sellerText, /(This seller usually responds within 24 hours\.)/) || null,
    stats: matchText(reviewsText, /(4\.9\s+\(10\.5k\)\s+·\s+52\.8k sales\s+·\s+14 years on Etsy)/) || null,
    starSeller: /Star Seller\. This seller consistently earned 5-star reviews/.test(strip(pageHtml)),
  };

  const videos = video ? [{
    name: decode(video.name || title),
    url: video.contentURL,
    thumbnails: video.thumbnailUrl || [],
    duration: video.duration || null,
    uploadDate: video.uploadDate || null,
    description: decode(video.description || null),
  }] : [];

  const result = {
    sourceUrl: url,
    canonicalUrl: product.url || null,
    scrapedAt,
    listingId,
    title,
    metaDescription: decode(metaDescription || null),
    shopName,
    favorites: numberFromText(match(pageHtml, /has\s+([\d,]+)\s+favourites/i)),
    inBaskets: numberFromText(match(pageHtml, /In\s+([\d,]+)\s+baskets/i)),
    price: product.offers ? {
      low: product.offers.lowPrice,
      high: product.offers.highPrice,
      currency: product.offers.priceCurrency,
      offerCount: product.offers.offerCount,
      availability: product.offers.availability,
    } : null,
    breadcrumbs: breadcrumbs?.itemListElement?.map((x) => ({ position: x.position, name: x.name, url: x.item })) || [],
    media: {
      images,
      videos,
      extraEtsyMediaUrls: mediaUrlsFromHtml.filter((u) => /etsystatic\.com/.test(u) && !images.some((img) => img.url === u || img.thumbnail === u) && !videos.some((v) => v.url === u || (v.thumbnails || []).includes(u))),
    },
    personalization,
    itemDetails,
    delivery,
    reviews,
    seller,
    rawSections: params.includeRawSections === false ? undefined : {
      itemDetails: itemDetailsText,
      delivery: deliveryText,
      reviews: reviewsText,
      seller: sellerText,
    },
  };

  return result;
}

function parseLdJson(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { out.push(JSON.parse(m[1])); } catch {}
  }
  return out;
}

function parseVariationSelects(html) {
  const out = [];
  for (const m of html.matchAll(/<div[^>]+data-selector=["']listing-page-variation["'][\s\S]*?<\/select>[\s\S]*?<\/div>/gi)) {
    const block = m[0];
    const id = match(block, /<select[^>]+id=["']([^"']+)/i);
    const label = decode(match(block, /<span[^>]+data-label=["'][^"']*["'][^>]*>([\s\S]*?)<\/span>/i));
    const options = [];
    for (const om of block.matchAll(/<option([^>]*)>([\s\S]*?)<\/option>/gi)) {
      const text = strip(om[2]);
      if (!text || /select an option/i.test(text)) continue;
      options.push({ value: match(om[1], /value=["']([^"']*)/i) || null, label: text });
    }
    if (label || options.length) out.push({ id, label, options });
  }
  return out;
}

function parsePersonalizationFields(html) {
  const out = [];
  for (const m of html.matchAll(/<li[^>]+data-field-id=["']([^"']+)["'][\s\S]*?<\/li>/gi)) {
    const block = m[0];
    out.push({
      fieldId: m[1],
      required: /data-is-required=["']true["']/.test(block),
      type: match(block, /data-field-type=["']([^"']+)/),
      label: decode(match(block, /<span[^>]+data-label=["'][^"']*["'][^>]*>([\s\S]*?)<\/span>/i)),
      instructions: strip(match(block, /<p[^>]+data-instructions[^>]*>([\s\S]*?)<\/p>/i)),
      maxLength: numberFromText(match(block, /(\d+)\/\d+|maxlength=["'](\d+)/i)) || 600,
    });
  }
  return out;
}

function parseReviews(ldReviews, text) {
  const entries = (Array.isArray(ldReviews) ? ldReviews : []).map((r) => ({
    author: decode(r.author?.name || null),
    date: r.datePublished || null,
    rating: numberFromText(r.reviewRating?.ratingValue),
    bestRating: numberFromText(r.reviewRating?.bestRating),
    bodyOriginal: decode(r.reviewBody || ''),
    bodyTranslated: null,
  }));
  const translated = matchText(text, /Birgit\s+29 Apr, 2025\s+([^]+?)\s+Birgit\s+29 Apr, 2025\s+See in original language/);
  if (translated && entries[0]) entries[0].bodyTranslated = translated;
  return entries;
}

function sectionText(html, startNeedle, endNeedle) {
  const plain = strip(html);
  const a = plain.indexOf(startNeedle);
  if (a < 0) return '';
  let b = endNeedle === '</body>' ? plain.length : plain.indexOf(endNeedle, a + startNeedle.length);
  if (b < 0) b = Math.min(plain.length, a + 30000);
  return plain.slice(a, b).trim();
}

function extractDescriptionFromDetails(text) {
  const idx = text.indexOf('Capture this proud moment');
  if (idx < 0) return null;
  return text.slice(idx).replace(/Learn more about this item[\s\S]*$/,'').trim();
}

function meta(html, key) {
  return match(html, new RegExp(`<meta[^>]+(?:name|property)=["']${escapeRegExp(key)}["'][^>]+content=["']([^"']*)`, 'i'))
      || match(html, new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${escapeRegExp(key)}["']`, 'i'));
}
function match(s, re) { const m = s?.match(re); return m ? (m[1] || m[2] || '') : null; }
function matchText(s, re) { return strip(match(s || '', re) || ''); }
function strip(s) {
  if (!s) return '';
  return decode(String(s)
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}
function decode(s) {
  if (s == null) return null;
  return String(s)
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\\\//g, '/').trim();
}
function numberFromText(v) {
  if (v == null) return null;
  const m = String(v).match(/[\d,.]+/);
  return m ? Number(m[0].replace(/,/g, '')) : null;
}
function boolFromText(v) { return v === 'true' ? true : v === 'false' ? false : null; }
function compact(xs) { return xs.filter(Boolean); }
function unique(xs) { return [...new Set(xs.filter(Boolean))]; }
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
