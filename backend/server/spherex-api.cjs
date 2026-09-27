const express = require('express');
const axios = require('axios');
const fs = require('fs');
const router = express.Router();

// Load pre-parsed SPHEREx catalog
const catalog = JSON.parse(fs.readFileSync('./spherex-catalog.json'));
const spatialIndex = JSON.parse(fs.readFileSync('./spherex-spatial-index.json'));

/**
 * GET /api/spherex/observations
 * Fetch observations for a sky region
 * Query params: ra, dec, radius (degrees), band
 */
router.get('/observations', (req, res) => {
  const { ra, dec, radius = 2, band = 'SPHEREx-D2' } = req.query;
  const ra_f = parseFloat(ra);
  const dec_f = parseFloat(dec);
  const radius_f = parseFloat(radius);

  if (isNaN(ra_f) || isNaN(dec_f)) {
    return res.status(400).json({ error: 'Invalid RA/Dec' });
  }

  // Get observations within radius using spatial index
  const nearbyObs = [];
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const gridKey = `${Math.floor(ra_f / 10) + di}_${Math.floor(dec_f / 10) + dj}`;
      const gridObs = spatialIndex[gridKey] || [];
      
      gridObs.forEach(obs => {
        const distance = Math.sqrt((obs.ra - ra_f) ** 2 + (obs.dec - dec_f) ** 2);
        if (distance <= radius_f && obs.wavelength_band === band) {
          nearbyObs.push({ ...obs, distance });
        }
      });
    }
  }

  // Sort by distance and return top 100
  nearbyObs.sort((a, b) => a.distance - b.distance);
  res.json(nearbyObs.slice(0, 100));
});

/**
 * POST /api/spherex/detect-moving-objects
 * Compare two surveys and detect moving objects
 * Body: { survey1_date, survey2_date, ra, dec }
 */
router.post('/detect-moving-objects', (req, res) => {
  const { survey1_date, survey2_date, ra, dec } = req.body;

  const obs1 = catalog.filter(o => o.obs_date.startsWith(survey1_date) && 
    Math.abs(o.ra - ra) < 5 && Math.abs(o.dec - dec) < 5);
  
  const obs2 = catalog.filter(o => o.obs_date.startsWith(survey2_date) && 
    Math.abs(o.ra - ra) < 5 && Math.abs(o.dec - dec) < 5);

  // Simple object detection: match objects between surveys
  const detectedObjects = [];
  const threshold = 0.1; // degrees (tolerance for same object)

  obs1.forEach(obj1 => {
    obs2.forEach(obj2 => {
      const distance = Math.sqrt((obj1.ra - obj2.ra) ** 2 + (obj1.dec - obj2.dec) ** 2);
      
      if (distance < threshold) {
        const raMovement = obj2.ra - obj1.ra;
        const decMovement = obj2.dec - obj1.dec;
        const totalMovement = Math.sqrt(raMovement ** 2 + decMovement ** 2);

        if (totalMovement > 0.001) { // Only if object actually moved
          detectedObjects.push({
            id: obj1.obs_id,
            type: obj1.target_type || 'Unknown',
            ra1: obj1.ra,
            dec1: obj1.dec,
            ra2: obj2.ra,
            dec2: obj2.dec,
            raMovement,
            decMovement,
            pixelDistance: totalMovement * 206265 / 6.2, // Convert to pixels (~6.2" per pixel)
            confidence: 0.85 + (Math.random() * 0.15), // Placeholder confidence
            targetName: obj1.target_name
          });
        }
      }
    });
  });

  res.json(detectedObjects.sort((a, b) => b.pixelDistance - a.pixelDistance));
});

/**
 * GET /api/spherex/image/:obsId
 * Fetch image from IRSA or AWS
 */
router.get('/image/:obsId', async (req, res) => {
  const { obsId } = req.params;
  const obs = catalog.find(o => o.obs_id === obsId);

  if (!obs) {
    return res.status(404).json({ error: 'Observation not found' });
  }

  try {
    // Try to fetch from IRSA first
    if (obs.access_url) {
      const imageRes = await axios.get(obs.access_url, { responseType: 'stream' });
      res.set('Content-Type', imageRes.headers['content-type']);
      imageRes.data.pipe(res);
    } else if (obs.aws_bucket) {
      // Alternative: Generate signed AWS URL
      const { bucket_name, key, region } = obs.aws_bucket.aws;
      const awsUrl = `https://${bucket_name}.s3.${region}.amazonaws.com/${key}`;
      res.redirect(awsUrl);
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch image', details: error.message });
  }
});

/**
 * GET /api/spherex/stats
 * Get statistics about the dataset
 */
router.get('/stats', (req, res) => {
  const bandCounts = {};
  const dateCounts = {};
  let totalSize = 0;

  catalog.forEach(obs => {
    bandCounts[obs.wavelength_band] = (bandCounts[obs.wavelength_band] || 0) + 1;
    const date = obs.obs_date.split(' ')[0];
    dateCounts[date] = (dateCounts[date] || 0) + 1;
    totalSize += obs.access_estsize || 0;
  });

  res.json({
    total_observations: catalog.length,
    total_data_size_mb: (totalSize / 1024 / 1024).toFixed(2),
    bands: bandCounts,
    surveys_by_date: dateCounts,
    unique_targets: new Set(catalog.map(o => o.target_name)).size
  });
});

/**
 * GET /api/spherex/search
 * Search for specific targets by name
 */
router.get('/search', (req, res) => {
  const { q, type } = req.query;

  if (!q) {
    return res.status(400).json({ error: 'Query parameter "q" is required' });
  }

  const results = catalog.filter(obs => {
    const matchName = obs.target_name?.toLowerCase().includes(q.toLowerCase());
    const matchType = !type || obs.target_type === type;
    return matchName && matchType;
  });

  res.json(results.slice(0, 50));
});

module.exports = router;
