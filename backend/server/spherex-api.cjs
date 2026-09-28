const express = require('express');
const axios = require('axios');
const { PNG } = require('pngjs');

const router = express.Router();

const IRSA_SIA_URL = process.env.SPHEREX_SIA_URL || 'https://irsa.ipac.caltech.edu/SIA';
const DEFAULT_RELEASES = (process.env.SPHEREX_RELEASES || 'spherex_qr3,spherex_qr2')
  .split(',').map((value) => value.trim()).filter(Boolean);
const UPSTREAM_TIMEOUT_MS = Number(process.env.SPHEREX_UPSTREAM_TIMEOUT_MS || 60000);
const QUERY_CACHE_TTL_MS = Number(process.env.SPHEREX_QUERY_CACHE_TTL_MS || 10 * 60 * 1000);
const IMAGE_CACHE_TTL_MS = Number(process.env.SPHEREX_IMAGE_CACHE_TTL_MS || 30 * 60 * 1000);
const IMAGE_CACHE_MAX_BYTES = Number(process.env.SPHEREX_IMAGE_CACHE_MAX_BYTES || 64 * 1024 * 1024);
const PREVIEW_SIZE_DEGREES = Number(process.env.SPHEREX_PREVIEW_SIZE_DEGREES || 0.5);

// Small bounded in-memory caches are intentional here: archive metadata and
// previews are requested on demand, never bulk-downloaded or persisted forever.
class TtlCache {
  constructor(maxBytes = Infinity) { this.items = new Map(); this.maxBytes = maxBytes; this.bytes = 0; }
  get(key) {
    const item = this.items.get(key);
    if (!item) return undefined;
    if (item.expiresAt < Date.now()) { this.delete(key); return undefined; }
    this.items.delete(key); this.items.set(key, item);
    return item.value;
  }
  set(key, value, ttl, bytes = 0) {
    this.delete(key);
    this.items.set(key, { value, expiresAt: Date.now() + ttl, bytes }); this.bytes += bytes;
    while (this.bytes > this.maxBytes && this.items.size) this.delete(this.items.keys().next().value);
  }
  delete(key) { const old = this.items.get(key); if (old) { this.bytes -= old.bytes || 0; this.items.delete(key); } }
}

const queryCache = new TtlCache();
const imageCache = new TtlCache(IMAGE_CACHE_MAX_BYTES);
const recordsByProduct = new Map();

const BAND_RANGES_MICRONS = {
  'SPHEREx-D1': [0.75, 1.10],
  'SPHEREx-D2': [1.10, 1.62],
  'SPHEREx-D3': [1.63, 2.41],
  'SPHEREx-D4': [2.42, 3.82],
  'SPHEREx-D5': [3.83, 4.41],
  'SPHEREx-D6': [4.42, 5.00]
};

function httpError(status, code, message, details) {
  const error = new Error(message); error.status = status; error.code = code; error.details = details; return error;
}

function parseCoordinate(value, name, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw httpError(400, 'INVALID_COORDINATE', `${name} must be between ${min} and ${max}.`);
  return number;
}

function parseRadius(value) {
  const radius = Number(value ?? 0.1);
  if (!Number.isFinite(radius) || radius <= 0 || radius > 5) throw httpError(400, 'INVALID_RADIUS', 'radius must be greater than 0 and no more than 5 degrees.');
  return radius;
}

function mjdToIso(mjd) {
  const date = new Date((Number(mjd) + 2400000.5 - 2440587.5) * 86400000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function asNumber(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }

function pointInFootprint(footprint, ra, dec) {
  if (!footprint || !footprint.startsWith('POLYGON')) return null;
  const values = footprint.match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)?.slice(0) || [];
  if (values.length < 6) return null;
  const points = [];
  for (let index = 0; index + 1 < values.length; index += 2) {
    const pointRa = Number(values[index]);
    const pointDec = Number(values[index + 1]);
    const relativeRa = ((pointRa - ra + 540) % 360) - 180;
    points.push([relativeRa, pointDec]);
  }
  const x = 0;
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const [xi, yi] = points[index]; const [xj, yj] = points[previous];
    const intersects = ((yi > dec) !== (yj > dec)) && (x < (xj - xi) * (dec - yi) / (yj - yi) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function parseSiaJson(payload) {
  const resources = payload?.VOTABLE?.RESOURCE_ARRAY;
  const result = Array.isArray(resources) ? resources.find((resource) => resource?.['<xmlattr>']?.type === 'results') : null;
  const table = result?.TABLE;
  const fields = table?.FIELD_ARRAY?.map((field) => field?.['<xmlattr>']?.name);
  const rows = table?.DATA?.TABLEDATA;
  if (!Array.isArray(fields) || !Array.isArray(rows)) throw new Error('IRSA returned an unexpected SIA response.');
  return rows.map((row) => Object.fromEntries(fields.map((field, index) => [field, row[index] ?? ''])));
}

function normalizeRecord(row, ra, dec, requestedRelease) {
  let cloudAccess = null;
  try { cloudAccess = row.cloud_access ? JSON.parse(row.cloud_access) : null; } catch { /* preserve null for malformed optional provenance */ }
  const productId = row.obs_publisher_did || row.access_url;
  const record = {
    obs_id: row.obs_id || productId,
    product_id: productId,
    ra: asNumber(row.s_ra),
    dec: asNumber(row.s_dec),
    distance: angularDistance(ra, dec, asNumber(row.s_ra), asNumber(row.s_dec)),
    coverage_at_query: pointInFootprint(row.s_region, ra, dec),
    obs_date: mjdToIso(row.t_min),
    obs_date_end: mjdToIso(row.t_max),
    mjd: asNumber(row.t_min),
    mjd_end: asNumber(row.t_max),
    wavelength_band: row.energy_bandpassname || null,
    wavelength_min_microns: asNumber(row.em_min) == null ? null : asNumber(row.em_min) * 1e6,
    wavelength_max_microns: asNumber(row.em_max) == null ? null : asNumber(row.em_max) * 1e6,
    spectral_resolution: asNumber(row.em_res_power),
    data_release: row.obs_collection || requestedRelease,
    access_url: row.access_url || null,
    original_archive_url: row.access_url || null,
    cutout_url: null,
    image_url: null,
    access_format: row.access_format || null,
    estimated_size_bytes: asNumber(row.access_estsize),
    exposure_seconds: asNumber(row.t_exptime),
    detector_pixels: row.s_xel1 && row.s_xel2 ? `${row.s_xel1} × ${row.s_xel2}` : null,
    pixel_scale_arcsec: asNumber(row.s_pixel_scale),
    field_of_view_degrees: asNumber(row.s_fov),
    target_name: row.target_name || null,
    target_type: row.target_type || null,
    target_moving: row.target_moving === '1',
    quality: {
      calibration_level: asNumber(row.calib_level),
      intent: row.obs_intent || null,
      environment_photometric: row.environment_photometric || null
    },
    provenance: {
      service: 'IRSA SIA2',
      collection: row.obs_collection || requestedRelease,
      publisher_did: row.obs_publisher_did || null,
      cloud_access: cloudAccess
    }
  };
  const query = new URLSearchParams({ product: productId, ra: String(ra), dec: String(dec), size: String(PREVIEW_SIZE_DEGREES) });
  record.image_url = `/api/spherex/image/${encodeURIComponent(record.obs_id)}?${query}`;
  record.cutout_url = `/api/spherex/cutout?${query}`;
  recordsByProduct.set(productId, { ...record, _upstreamUrl: row.access_url });
  return record;
}

function angularDistance(ra1, dec1, ra2, dec2) {
  if (![ra1, dec1, ra2, dec2].every(Number.isFinite)) return null;
  const toRad = Math.PI / 180;
  const a = Math.sin((dec2 - dec1) * toRad / 2) ** 2 + Math.cos(dec1 * toRad) * Math.cos(dec2 * toRad) * Math.sin((ra2 - ra1) * toRad / 2) ** 2;
  return 2 * Math.asin(Math.sqrt(Math.min(1, a))) / toRad;
}

async function queryRelease({ ra, dec, radius, band, release }) {
  const range = BAND_RANGES_MICRONS[band];
  const params = new URLSearchParams({
    COLLECTION: release,
    POS: `circle ${ra} ${dec} ${radius}`,
    RESPONSEFORMAT: 'JSON',
    MAXREC: '500'
  });
  if (range) params.set('BAND', `${range[0] * 1e-6} ${range[1] * 1e-6}`);
  const response = await axios.get(`${IRSA_SIA_URL}?${params}`, { timeout: UPSTREAM_TIMEOUT_MS, responseType: 'json' });
  return parseSiaJson(response.data);
}

async function getObservations({ ra, dec, radius, band }) {
  const key = `${ra.toFixed(6)}:${dec.toFixed(6)}:${radius.toFixed(5)}:${band}:${DEFAULT_RELEASES.join(',')}`;
  const cached = queryCache.get(key);
  if (cached) return cached;
  const responses = await Promise.allSettled(DEFAULT_RELEASES.map((release) => queryRelease({ ra, dec, radius, band, release })));
  const rejected = responses.filter((result) => result.status === 'rejected');
  const rows = responses.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
  if (!rows.length && rejected.length === responses.length) throw httpError(502, 'IRSA_UNAVAILABLE', 'IRSA did not return observation metadata.', rejected[0].reason?.message);
  const seen = new Set();
  const records = rows.map((row, index) => normalizeRecord(row, ra, dec, DEFAULT_RELEASES[index] || DEFAULT_RELEASES[0]))
    .filter((record) => record.access_url && record.ra != null && record.dec != null)
    .filter((record) => record.coverage_at_query !== false)
    .filter((record) => !band || record.wavelength_band === band)
    .filter((record) => record.field_of_view_degrees == null || record.distance == null || record.distance <= (record.field_of_view_degrees / 2) - (PREVIEW_SIZE_DEGREES / 2))
    .filter((record) => { if (seen.has(record.product_id)) return false; seen.add(record.product_id); return true; })
    .sort((a, b) => (a.mjd ?? Infinity) - (b.mjd ?? Infinity) || (a.distance ?? Infinity) - (b.distance ?? Infinity));
  queryCache.set(key, records, QUERY_CACHE_TTL_MS);
  return records;
}

function getRecord(product, obsId) {
  if (product && recordsByProduct.has(product)) return recordsByProduct.get(product);
  for (const record of recordsByProduct.values()) if (record.obs_id === obsId) return record;
  return null;
}

function validateCutoutSize(value) {
  const size = Number(value ?? PREVIEW_SIZE_DEGREES);
  if (!Number.isFinite(size) || size < 0.01 || size > 0.5) throw httpError(400, 'INVALID_CUTOUT_SIZE', 'size must be between 0.01 and 0.5 degrees.');
  return size;
}

function cutoutUrl(record, ra, dec, size) {
  const url = new URL(record._upstreamUrl);
  url.search = new URLSearchParams({ center: `${ra},${dec}d`, size: String(size) }).toString();
  return url.toString();
}

// FITS headers are fixed-width 80-byte cards in 2880-byte blocks. This small
// reader intentionally handles only the uncompressed image HDU needed for a
// visual preview; raw scientific MEFs remain available through /cutout.
function readFitsImage(buffer) {
  let offset = 0;
  while (offset + 2880 <= buffer.length) {
    const headerStart = offset;
    const cards = [];
    let endCard = -1;
    for (let cursor = offset; cursor + 80 <= buffer.length; cursor += 80) {
      const card = buffer.toString('ascii', cursor, cursor + 80);
      cards.push(card);
      if (card.slice(0, 8).trim() === 'END') { endCard = cards.length; break; }
    }
    if (endCard < 0) throw new Error('FITS header is incomplete.');
    const headerBytes = Math.ceil((endCard * 80) / 2880) * 2880;
    const header = {};
    for (const card of cards) {
      const key = card.slice(0, 8).trim();
      if (!key || key === 'END' || card[8] !== '=') continue;
      const raw = card.slice(10).split('/')[0].trim();
      header[key] = raw.startsWith("'") ? raw.slice(1, raw.lastIndexOf("'")) : raw === 'T' ? true : raw === 'F' ? false : Number(raw.replace(/D/g, 'E'));
    }
    const naxis = Number(header.NAXIS || 0);
    const width = Number(header.NAXIS1 || 0);
    const height = Number(header.NAXIS2 || 0);
    const bitpix = Number(header.BITPIX || 0);
    const pixelBytes = Math.abs(bitpix) / 8;
    const dataBytes = naxis ? Math.max(0, Number(header.GCOUNT || 1) * (Number(header.PCOUNT || 0) + [...Array(naxis)].reduce((total, _, index) => total * Number(header[`NAXIS${index + 1}`] || 0), 1) * pixelBytes)) : 0;
    const dataStart = headerStart + headerBytes;
    if (naxis >= 2 && width > 0 && height > 0 && pixelBytes >= 1 && dataStart + width * height * pixelBytes <= buffer.length) {
      const values = new Float64Array(width * height);
      for (let index = 0; index < values.length; index++) {
        const position = dataStart + index * pixelBytes;
        values[index] = bitpix === -32 ? buffer.readFloatBE(position) : bitpix === -64 ? buffer.readDoubleBE(position) : bitpix === 16 ? buffer.readInt16BE(position) : bitpix === 32 ? buffer.readInt32BE(position) : bitpix === 8 ? buffer[position] : NaN;
        values[index] = values[index] * Number(header.BSCALE || 1) + Number(header.BZERO || 0);
      }
      return { width, height, values };
    }
    offset = dataStart + Math.ceil(dataBytes / 2880) * 2880;
  }
  throw new Error('FITS image extension not found.');
}

function imageToPng(image) {
  const finite = Array.from(image.values).filter(Number.isFinite).sort((a, b) => a - b);
  if (!finite.length) throw new Error('FITS image contains no finite pixels.');
  const low = finite[Math.floor(finite.length * 0.01)];
  const high = finite[Math.max(0, Math.floor(finite.length * 0.995))] || low + 1;
  const range = high > low ? high - low : 1;
  // An asinh stretch keeps bright sources from dominating while retaining
  // faint extended structure. Percentile limits avoid a single bad pixel
  // deciding the display range; raw FITS values remain untouched.
  const stretchScale = range / 3;
  const stretchMax = Math.asinh(range / stretchScale);
  const png = new PNG({ width: image.width, height: image.height });
  for (let index = 0; index < image.values.length; index++) {
    const normalized = Math.max(0, Math.min(1, Math.asinh(Math.max(0, image.values[index] - low) / stretchScale) / stretchMax));
    const value = Math.round(normalized * 255);
    const pixel = index * 4;
    png.data[pixel] = Math.round(value * 0.72);
    png.data[pixel + 1] = Math.round(value * 0.86);
    png.data[pixel + 2] = value;
    png.data[pixel + 3] = 255;
  }
  return PNG.sync.write(png);
}

async function fetchPreview(record, ra, dec, size) {
  const key = `${record.product_id}:${ra.toFixed(6)}:${dec.toFixed(6)}:${size}`;
  const cached = imageCache.get(key);
  if (cached) return cached;
  let response;
  try {
    response = await axios.get(cutoutUrl(record, ra, dec, size), { responseType: 'arraybuffer', timeout: UPSTREAM_TIMEOUT_MS, maxContentLength: 25 * 1024 * 1024 });
  } catch (error) {
    // SIA returns products whose footprint intersects the search circle. An
    // edge product can therefore reject a cutout at the user's exact point;
    // use the real product center for a useful preview rather than hiding the
    // observation from a temporal comparison. Raw /cutout remains exact.
    if (error.response?.status !== 422 || !Number.isFinite(record.ra) || !Number.isFinite(record.dec)) throw error;
    response = await axios.get(cutoutUrl(record, record.ra, record.dec, size), { responseType: 'arraybuffer', timeout: UPSTREAM_TIMEOUT_MS, maxContentLength: 25 * 1024 * 1024 });
  }
  const png = imageToPng(readFitsImage(Buffer.from(response.data)));
  imageCache.set(key, png, IMAGE_CACHE_TTL_MS, png.length);
  return png;
}

async function sendPreview(req, res) {
  const ra = parseCoordinate(req.query.ra, 'ra', 0, 360);
  const dec = parseCoordinate(req.query.dec, 'dec', -90, 90);
  const size = validateCutoutSize(req.query.size);
  const record = getRecord(req.query.product, req.params.obsId);
  if (!record) throw httpError(404, 'OBSERVATION_NOT_FOUND', 'Observation metadata is no longer in the server cache. Query observations again first.');
  const png = await fetchPreview(record, ra, dec, size);
  res.set({ 'Content-Type': 'image/png', 'Cache-Control': `public, max-age=${Math.floor(IMAGE_CACHE_TTL_MS / 1000)}`, 'X-Data-Source': 'NASA/IPAC IRSA SPHEREx cutout' });
  res.send(png);
}

router.get('/observations', async (req, res, next) => {
  try {
    const ra = parseCoordinate(req.query.ra, 'ra', 0, 360);
    const dec = parseCoordinate(req.query.dec, 'dec', -90, 90);
    const radius = parseRadius(req.query.radius);
    const band = req.query.band || 'SPHEREx-D2';
    if (band !== 'all' && !BAND_RANGES_MICRONS[band]) throw httpError(400, 'INVALID_BAND', 'band must be one of SPHEREx-D1 through SPHEREx-D6, or all.');
    const records = await getObservations({ ra, dec, radius, band: band === 'all' ? null : band });
    res.json(records.slice(0, 500));
  } catch (error) { next(error); }
});

router.get('/image/:obsId', async (req, res, next) => { try { await sendPreview(req, res); } catch (error) { next(error); } });

router.get('/cutout', async (req, res, next) => {
  try {
    const record = getRecord(req.query.product);
    if (!record) throw httpError(404, 'OBSERVATION_NOT_FOUND', 'Observation metadata is no longer in the server cache. Query observations again first.');
    const ra = parseCoordinate(req.query.ra, 'ra', 0, 360);
    const dec = parseCoordinate(req.query.dec, 'dec', -90, 90);
    const size = validateCutoutSize(req.query.size);
    const response = await axios.get(cutoutUrl(record, ra, dec, size), { responseType: 'stream', timeout: UPSTREAM_TIMEOUT_MS, maxContentLength: 25 * 1024 * 1024 });
    res.set({ 'Content-Type': 'application/fits', 'Content-Disposition': `inline; filename="${record.obs_id}-cutout.fits"`, 'X-Data-Source': 'NASA/IPAC IRSA SPHEREx cutout service' });
    response.data.on('error', next).pipe(res);
  } catch (error) { next(error); }
});

router.post('/detect-moving-objects', (req, res) => res.status(501).json({ error: 'MOVING_OBJECT_ANALYSIS_UNAVAILABLE', message: 'This API does not infer object classifications or motion from image metadata. Use repeated observations for human or validated downstream analysis.' }));
router.get('/search', (req, res) => res.status(501).json({ error: 'SEARCH_UNAVAILABLE', message: 'Target-name search is not provided by the SIA metadata service. Search by sky coordinates instead.' }));
router.get('/stats', (req, res) => res.json({ source: 'NASA/IPAC IRSA SIA2', releases: DEFAULT_RELEASES, query_mode: 'on-demand', cache: { metadata_ttl_seconds: QUERY_CACHE_TTL_MS / 1000, preview_cache_max_bytes: IMAGE_CACHE_MAX_BYTES }, total_observations: null, bands: null, surveys_by_date: null, unique_targets: null }));

router.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.status || (error.code === 'ECONNABORTED' ? 504 : 502);
  res.status(status).json({ error: error.code || 'UPSTREAM_ERROR', message: error.message || 'The SPHEREx data service could not complete the request.', ...(process.env.NODE_ENV === 'development' && error.details ? { details: error.details } : {}) });
});

module.exports = router;
