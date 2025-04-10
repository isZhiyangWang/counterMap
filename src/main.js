import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import "leaflet-toolbar";
import "leaflet-distortableimage";
import './Leaflet.ImageOverlay.Rotated.js'; // Custom rotated overlay plugin

// Global flag: scroll-guided animation toggle
window.scrollGuidedEnabled = true;

/**
 * Utility: Add an overlay image using corner positions
 */
function addOverlayImage(options) {
  if (!options.overlayBounds || !options.overlayImage) return null;

  const b = options.overlayBounds;

  // Order of corners: top-left, top-right, bottom-right, bottom-left
  const corners = [
    L.latLng(b[0][0], b[0][1]), // top-left
    L.latLng(b[1][0], b[1][1]), // top-right
    L.latLng(b[3][0], b[3][1]), // bottom-right
    L.latLng(b[2][0], b[2][1])  // bottom-left
  ];

  const overlay = L.distortableImageOverlay(options.overlayImage, {
    corners: corners,
    opacity: options.overlayOpacity || 0.5,
  });

  overlay.once('load', () => {
    if (overlay._image) {
      overlay._image.style.opacity = (options.overlayOpacity || 0.5).toString();
    }
  });

  overlay.addTo(window.map);
  return overlay;
}

/**
 * Utility: Compute the center of a set of bounds
 */
function getBoundsCenter(bounds) {
  let latSum = 0, lngSum = 0;
  bounds.forEach(pt => {
    latSum += pt[0];
    lngSum += pt[1];
  });
  return [latSum / bounds.length, lngSum / bounds.length];
}

/**
 * Utility: Get min/max latitude and longitude of bounds
 */
function getMinMaxLatLng(bounds) {
  let minLat = Infinity, maxLat = -Infinity;
  let minLng = Infinity, maxLng = -Infinity;

  bounds.forEach(([lat, lng]) => {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  });

  return { minLat, maxLat, minLng, maxLng };
}

/**
 * Utility: Shift overlay bounds by a lat/lng offset
 */
function shiftOverlayBounds(bounds, latOffset, lngOffset) {
  return bounds.map(([lat, lng]) => [lat + latOffset, lng + lngOffset]);
}

window.addEventListener('load', async () => {
  const loadingOverlay = document.getElementById('loadingOverlay');

  try {
    // 1. Initialize map
    window.map = L.map('map', {
      center: [18.5, -72.0],
      zoom: 7,
      minZoom: 6,
      maxZoom: 20
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: 'Map data © OpenStreetMap contributors, © CARTO'
    }).addTo(window.map);

    // 2. Load map data
    const resp = await fetch('/data/mapsData.json');
    const data = await resp.json();

    // Create region lookup
    const regionMap = {};
    data.maps.filter(m => m.type === 'region').forEach(region => {
      regionMap[region.id] = region;
    });

    // Render all regions first
    Object.values(regionMap).forEach(region => {
      addOverlayImage(region);
      region._center = getBoundsCenter(region.overlayBounds);
      const mm = getMinMaxLatLng(region.overlayBounds);
      region._minLng = mm.minLng;
      region._maxLng = mm.maxLng;
    });

    // 3. Render towns adjacent to their regions
    const towns = data.maps.filter(m => m.type === 'town');

    towns.forEach(town => {
      const region = regionMap[town.regionId];
      if (!region) {
        console.warn('Invalid region ID for town:', town);
        return;
      }

      const townCenter = getBoundsCenter(town.overlayBounds);

      // Draw a rectangle for debugging
      const rectSize = 0.005;
      L.rectangle([
        [townCenter[0] - rectSize, townCenter[1] - rectSize],
        [townCenter[0] + rectSize, townCenter[1] + rectSize]
      ], { color: 'blue', weight: 1 }).addTo(window.map);

      // Determine left/right offset direction
      let offsetBounds = [];
      const margin = 0.02;

      const { minLng, maxLng } = getMinMaxLatLng(town.overlayBounds);
      if (townCenter[1] >= region._center[1]) {
        const shiftLng = (region._maxLng + margin) - minLng;
        offsetBounds = shiftOverlayBounds(town.overlayBounds, 0, shiftLng);
      } else {
        const shiftLng = (region._minLng - margin) - maxLng;
        offsetBounds = shiftOverlayBounds(town.overlayBounds, 0, shiftLng);
      }

      const layer = addOverlayImage({
        ...town,
        overlayBounds: offsetBounds,
        overlayOpacity: town.overlayOpacity || 0.6
      });

      if (layer?.setZIndex) {
        layer.setZIndex(9999);
      }

      const newCenter = getBoundsCenter(offsetBounds);
      L.polyline([townCenter, newCenter], {
        color: 'blue',
        weight: 1
      }).addTo(window.map);
    });

    // 4. Auto-fit map to the "Overall" overlay (id=1)
    const overallItem = data.maps.find(m => m.id === 1);
    if (overallItem) {
      const b = overallItem.overlayBounds;
      const bounds = L.latLngBounds([
        [b[0][0], b[0][1]],
        [b[1][0], b[1][1]],
        [b[2][0], b[2][1]],
        [b[3][0], b[3][1]]
      ]);
      window.map.fitBounds(bounds, { padding: [10, 10] });
      
    }

    // 5. Render region cards in the sidebar
    renderRegionList(data.maps);

    loadingOverlay.classList.add('hidden');
  } catch (err) {
    console.error('Error loading map:', err);
    loadingOverlay.classList.add('hidden');
  }

  // Toggle scroll-guided animation
  const scrollToggleCheckbox = document.getElementById('scrollToggleCheckbox');
  scrollToggleCheckbox.addEventListener('change', e => {
    window.scrollGuidedEnabled = e.target.checked;
    console.log('Scroll guided =', window.scrollGuidedEnabled);
  });
});

/**
 * Render region title cards on the right-hand panel
 */
function renderRegionList(mapItems) {
  const regionList = document.getElementById('regionList');
  regionList.innerHTML = '';

  mapItems.forEach(item => {
    const card = document.createElement('div');
    card.classList.add('region-card');
    card.textContent = item.title;

    card.addEventListener('mouseover', () => {
      if (!window.map) return;
      const b = item.overlayBounds;
      const bounds = L.latLngBounds(
        [b[2][0], b[0][1]],
        [b[0][0], b[1][1]]
      );
      window.map.flyToBounds(bounds, { maxZoom: 11 });
    });

    card.addEventListener('click', () => {
      window.location.href = item.detailPage;
    });

    regionList.appendChild(card);
  });
}
