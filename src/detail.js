/*
 * detail.js
 *
 * A self-contained module that sets up a detailed map using Leaflet with PDF processing 
 * via pdfjs-dist. It handles PDF text extraction, interactive markers, overlays, and a modal dialog 
 * for viewing full PDF content.
 *
 */

// ==============================
// Imports & PDF Worker Setup
// ==============================
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import "leaflet-toolbar";
import "leaflet-distortableimage";
import './Leaflet.ImageOverlay.Rotated.js';

// Import PDF.js library and its worker source.
import * as pdfjsLib from 'pdfjs-dist';
import workerSource from 'pdfjs-dist/build/pdf.worker.mjs?raw';

// Create a Blob URL from the worker source and set it as PDF.js worker.
const blob = new Blob([workerSource], { type: 'application/javascript' });
const workerBlobUrl = URL.createObjectURL(blob);
pdfjsLib.GlobalWorkerOptions.workerSrc = workerBlobUrl;

// ==============================
// Global Variables
// ==============================
let detailMap;
let markersLayer;
let currentRegionData = null;
let currentOpenIdx = null;
let overlay = null;

// ==============================
// PDF Processing Functions
// ==============================
/**
 * Asynchronously loads and extracts text from a PDF.
 *
 * @param {string} pdfUrl - URL of the PDF file.
 * @returns {Promise<string>} - HTML formatted text extracted from the PDF.
 */
async function loadPdfText(pdfUrl) {
  // 1) Load PDF
  const loadingTask = pdfjsLib.getDocument(pdfUrl);
  const pdf = await loadingTask.promise;

  // Global storage for main paragraphs and footer candidates.
  let allMainParagraphs = [];
  let allFooterCandidates = [];

  // Function: Check if the line could be a footnote.
  const footnoteStartRegex = /^(\d+)[\.\)]?\s+(.*)$/;

  // Function: Merge isolated numbers into following text if applicable.
  function preprocessMainItems(items, minYForFootnotes) {
    let newItems = [];
    for (let i = 0; i < items.length; i++) {
      const cur = items[i];
      const next = items[i + 1];
      const curText = cur.str.trim();
      if (/^\d{1,2}$/.test(curText) && cur.width < 10 && cur.transform[5] > minYForFootnotes && next) {
        const nextText = next.str.trim();
        if (!/^\d+$/.test(nextText)) {
          next.str = nextText + curText;
          continue;
        }
      }
      newItems.push(cur);
    }
    return newItems;
  }

  // Process each page.
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const pageHeight = viewport.height;

    // Get and sort text items (from top to bottom).
    const textContent = await page.getTextContent();
    let items = textContent.items;
    items.sort((a, b) => b.transform[5] - a.transform[5]);

    // Separate into main items and footer items.
    let mainItems = [];
    let footerItems = [];
    for (let it of items) {
      if (it.transform[5] < pageHeight * 0.3) {
        footerItems.push(it);
      } else {
        mainItems.push(it);
      }
    }

    mainItems = preprocessMainItems(mainItems, pageHeight * 0.3);

    // Merge main items into paragraphs.
    let pageMainParagraphs = [];
    {
      let currentParagraph = null;
      let lastY = null;
      const lineThreshold = 20;
      for (const item of mainItems) {
        const txt = item.str.trim();
        if (!txt) continue;
        const thisY = item.transform[5];
        if (!currentParagraph) {
          currentParagraph = { text: txt, y: thisY };
        } else {
          if (Math.abs(thisY - lastY) < lineThreshold) {
            currentParagraph.text += " " + txt;
          } else {
            pageMainParagraphs.push(currentParagraph);
            currentParagraph = { text: txt, y: thisY };
          }
        }
        lastY = thisY;
      }
      if (currentParagraph) {
        pageMainParagraphs.push(currentParagraph);
      }
      pageMainParagraphs.sort((a, b) => b.y - a.y);
    }

    // Merge footer items into paragraphs.
    let pageFooterParagraphs = [];
    {
      let currentParagraph = null;
      let lastY = null;
      const lineThreshold = 20;
      for (const item of footerItems) {
        const txt = item.str.trim();
        if (!txt) continue;
        const thisY = item.transform[5];
        if (!currentParagraph) {
          currentParagraph = { text: txt, y: thisY };
        } else {
          if (Math.abs(thisY - lastY) < lineThreshold) {
            currentParagraph.text += " " + txt;
          } else {
            pageFooterParagraphs.push(currentParagraph);
            currentParagraph = { text: txt, y: thisY };
          }
        }
        lastY = thisY;
      }
      if (currentParagraph) {
        pageFooterParagraphs.push(currentParagraph);
      }
      pageFooterParagraphs.sort((a, b) => b.y - a.y);
    }

    for (let p of pageMainParagraphs) {
      allMainParagraphs.push({ text: p.text, pageNum });
    }
    for (let f of pageFooterParagraphs) {
      allFooterCandidates.push({ text: f.text, pageNum });
    }
  } // END for each page

  // Merge footer candidates into global footnotes.
  let globalFootnotes = {};
  let footnoteOrder = [];
  let idx = 0;
  while (idx < allFooterCandidates.length) {
    const lineObj = allFooterCandidates[idx];
    const lineText = lineObj.text;
    const match = lineText.match(/^(\d+)[\.\)]?\s+(.*)$/);
    if (match) {
      let footnoteNum = match[1];
      let footnoteContent = match[2];
      idx++;
      while (idx < allFooterCandidates.length) {
        const nxtText = allFooterCandidates[idx].text;
        if (footnoteStartRegex.test(nxtText)) break;
        footnoteContent += " " + nxtText.trim();
        idx++;
      }
      if (!globalFootnotes[footnoteNum]) {
        globalFootnotes[footnoteNum] = footnoteContent;
        footnoteOrder.push(footnoteNum);
      } else {
        globalFootnotes[footnoteNum] += " " + footnoteContent;
      }
    } else {
      if (footnoteOrder.length > 0) {
        let lastNum = footnoteOrder[footnoteOrder.length - 1];
        globalFootnotes[lastNum] += " " + lineText.trim();
      }
      idx++;
    }
  }

  // Second round: split combined footnotes if needed.
  let newGlobalFootnotes = {};
  let newFootnoteOrder = [];
  function splitFootnoteText(text) {
    let modified = text.replace(/(\.\s+)(\d+[\.\)]?\s+)/g, "$1###SPLIT###$2");
    return modified.split("###SPLIT###").map(s => s.trim()).filter(Boolean);
  }
  for (let origKey of footnoteOrder) {
    let fullText = (globalFootnotes[origKey] || "").trim();
    let parts = splitFootnoteText(fullText);
    if (parts.length === 1) {
      newGlobalFootnotes[origKey] = parts[0];
      newFootnoteOrder.push(origKey);
    } else {
      let m0 = parts[0].match(/^(\d+)[\.\)]?\s+(.*)$/);
      if (m0) {
        newGlobalFootnotes[origKey] = m0[2].trim();
      } else {
        newGlobalFootnotes[origKey] = parts[0];
      }
      newFootnoteOrder.push(origKey);
      for (let i = 1; i < parts.length; i++) {
        let m = parts[i].match(/^(\d+)[\.\)]?\s+(.*)$/);
        if (m) {
          let newNum = m[1];
          let newText = m[2].trim();
          newGlobalFootnotes[newNum] = newText;
          newFootnoteOrder.push(newNum);
        } else {
          let lastK = newFootnoteOrder[newFootnoteOrder.length - 1];
          newGlobalFootnotes[lastK] += " " + parts[i];
        }
      }
    }
  }
  globalFootnotes = newGlobalFootnotes;
  footnoteOrder = newFootnoteOrder;
  
  // Replace digit references in main paragraphs with <sup> tags if they exist as footnotes.
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const footnoteRefRegex = /(^|[\s,"'()\[\].;:\-])(\d+)(?=$|[\s,"'()\[\].;:\-])/g;
  const finalMainHtml = allMainParagraphs.map((par, idx) => {
    let replaced = par.text.replace(footnoteRefRegex, (match, p1, p2, offset, fullText) => {
      const afterMatch = fullText.substring(offset + match.length);
      for (let mon of monthNames) {
        if (afterMatch.trim().startsWith(mon)) {
          return match;
        }
      }
      if (globalFootnotes[p2]) {
        return p1 + `<sup>${p2}</sup>`;
      }
      return match;
    });
    
    if (idx === 0) {
      return `<h1 data-page="${par.pageNum}">${replaced}</h1>`;
    } else if (idx === 1) {
      return `<p data-page="${par.pageNum}" style="font-style: italic;">${replaced}</p>`;
    } else {
      return `<p data-page="${par.pageNum}">${replaced}</p>`;
    }
  }).join("\n");

  footnoteOrder.sort((a, b) => Number(a) - Number(b));
  let footnotesHtml = "";
  if (footnoteOrder.length > 0) {
    footnotesHtml = `<div class="aggregated-footnotes"><hr>\n` +
      footnoteOrder.map(num => {
        let txt = (globalFootnotes[num] || "").trim();
        return `<p class="footnote"><sup>${num}</sup> ${txt}</p>`;
      }).join("\n") +
      `\n</div>`;
  }

  return finalMainHtml + "\n" + footnotesHtml;
}

/**
 * Processes markers with PDF URLs by extracting text and handling highlights.
 *
 * @param {Array} markers - Array of marker objects.
 */
async function processMarkersPdfText(markers) {
  for (let idx = 0; idx < markers.length; idx++) {
    const mk = markers[idx];
    console.log(mk.pdfHighlights);
    
    if (mk.pdfUrl) {
      try {
        let pdfText = await loadPdfText(mk.pdfUrl);

        if (Array.isArray(mk.pdfHighlights)) {
          mk.pdfHighlights.forEach(highlight => {
            const { keyword, markerIdx, url } = highlight;
            const safeKeyword = escapeRegExp(keyword);

            const replacement = markerIdx === 'url'
              ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${keyword}</a>`
              : `<span class="marker-highlight" data-marker="${markerIdx}">${keyword}</span>`;

            const regex = new RegExp(safeKeyword, 'g');
            pdfText = pdfText.replace(regex, replacement);
          });
        }
        mk.pdfExcerpt = pdfText;
      } catch (err) {
        console.error('PDF parsing failed:', mk.pdfUrl, err);
        mk.pdfExcerpt = '(Failed to parse PDF text.)';
      }
    }
  }
}

// ==============================
// Utility Functions
// ==============================
/**
 * Escapes special regex characters.
 *
 * @param {string} string - Input string.
 * @returns {string} - Escaped string.
 */
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ==============================
// PDF Modal Setup Functions
// ==============================
/**
 * Creates and appends a modal dialog for displaying PDFs.
 */
function createPdfModal() {
  const modalDiv = document.createElement('div');
  modalDiv.id = 'pdfModal';
  modalDiv.className = 'pdf-modal';

  const contentDiv = document.createElement('div');
  contentDiv.className = 'pdf-modal-content';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'pdf-modal-close-btn';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => {
    modalDiv.style.display = 'none';
  });

  const pdfContainer = document.createElement('div');
  pdfContainer.id = 'pdfContainer';

  contentDiv.appendChild(closeBtn);
  contentDiv.appendChild(pdfContainer);
  modalDiv.appendChild(contentDiv);
  document.body.appendChild(modalDiv);
}

/**
 * Opens the PDF modal and loads the PDF via an iframe.
 *
 * @param {string} pdfUrl - The URL of the PDF.
 */
function openPdfModal(pdfUrl) {
  const modal = document.getElementById('pdfModal');
  const pdfContainer = document.getElementById('pdfContainer');
  if (!modal || !pdfContainer) return;

  pdfContainer.innerHTML = '';
  const iframe = document.createElement('iframe');
  iframe.src = pdfUrl;
  iframe.style.width = '100%';
  iframe.style.height = '600px';
  pdfContainer.appendChild(iframe);

  modal.style.display = 'flex';
}

// ==============================
// Map Initialization & Marker Functions
// ==============================
/**
 * Initializes the detailed map with a region's data.
 *
 * @param {Object} region - Region data including coordinates, overlay, and markers.
 */
function initDetailMap(region) {
  detailMap = L.map('detailMap', {
    center: region.coordinates,
    zoom: 10,
    minZoom: 7,
    maxZoom: 20
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: 'Map data © OpenStreetMap contributors, © CARTO'
  }).addTo(detailMap);

  const b = region.overlayBounds;
  const corners = [
    L.latLng(b[0][0], b[0][1]),
    L.latLng(b[1][0], b[1][1]),
    L.latLng(b[3][0], b[3][1]),
    L.latLng(b[2][0], b[2][1])
  ];

  overlay = L.distortableImageOverlay(region.overlayImage, {
    corners: corners,
    opacity: region.overlayOpacity || 0.7,
  }).addTo(detailMap);

  overlay.once('load', () => {
    if (overlay._image) {
      overlay._image.style.opacity = (region.overlayOpacity || 0.5).toString();
    }
  });

  const latValues = [b[0][0], b[1][0], b[2][0], b[3][0]];
  const lngValues = [b[0][1], b[1][1], b[2][1], b[3][1]];
  const minLat = Math.min(...latValues);
  const maxLat = Math.max(...latValues);
  const minLng = Math.min(...lngValues);
  const maxLng = Math.max(...lngValues);

  detailMap.fitBounds([
    [minLat, minLng],
    [maxLat, maxLng]
  ]);

  markersLayer = L.layerGroup().addTo(detailMap);

  if (region.markers && region.markers.length > 0) {
    region.markers.forEach((mk, idx) => {
      const marker = L.marker(mk.coordinates).addTo(markersLayer);
      marker.bindPopup(`
        <strong>${mk.title}</strong>
      `);
      marker.on('click', () => {
        detailMap.flyTo(mk.coordinates, 18);
        marker.openPopup();
      });
    });
  }

  addResetViewButton([
    [minLat, minLng],
    [maxLat, maxLng]
  ]);
  addOverlayOpacitySlider(region.overlayOpacity || 0.5);
}

/**
 * Adds a reset view button to the map.
 *
 * @param {Array} initialBounds - The initial map bounds.
 */
function addResetViewButton(initialBounds) {
  const resetViewControl = L.control({ position: 'topright' });

  resetViewControl.onAdd = function () {
    const button = L.DomUtil.create('button', 'reset-view-button');
    button.innerHTML = '⟳ Overview';
    button.title = 'Reset to initial view';

    L.DomEvent.disableClickPropagation(button);
    L.DomEvent.on(button, 'click', () => {
      detailMap.fitBounds(initialBounds);

      if (currentOpenIdx !== null) {
        const prevDiv = document.getElementById(`markerItem-${currentOpenIdx}`);
        const prevDesc = prevDiv?.querySelector('.marker-description');
        prevDesc?.classList.remove('open');
        currentOpenIdx = null;
      }

      markersLayer.getLayers().forEach(marker => {
        marker.closePopup();
      });
    });

    return button;
  };

  resetViewControl.addTo(detailMap);
}

/**
 * Adds an opacity slider control for the overlay.
 *
 * @param {number} defaultOpacity - Default opacity value.
 */
function addOverlayOpacitySlider(defaultOpacity) {
  const SliderControl = L.Control.extend({
    onAdd: function () {
      const container = L.DomUtil.create('div', 'overlay-opacity-slider');
      container.style.padding = '4px 8px';
      container.style.background = '#fff';

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = 0;
      slider.max = 1;
      slider.step = 0.05;
      slider.value = defaultOpacity;
      slider.style.width = '100px';
      container.appendChild(slider);

      const valLabel = document.createElement('span');
      valLabel.textContent = defaultOpacity;
      valLabel.style.marginLeft = '6px';
      container.appendChild(valLabel);

      L.DomEvent.disableClickPropagation(container);

      slider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        overlay.setOpacity(val);
        valLabel.textContent = val.toFixed(2);
      });

      return container;
    }
  });

  const sliderControl = new SliderControl({ position: 'topright' });
  detailMap.addControl(sliderControl);
}

/**
 * Toggles (expands) the marker description.
 * Updated: when a marker item is clicked, it expands (after closing other open ones)
 * but does not collapse on its own – the close action is handled by the close button.
 *
 * @param {number} idx - Index of the marker.
 */
function toggleMarkerDescription(idx) {
  const currentDiv = document.getElementById(`markerItem-${idx}`);
  if (!currentDiv) return;

  const currentDesc = currentDiv.querySelector('.marker-description');

  // If already expanded, do nothing (collapse will be done via the close button)
  if (currentOpenIdx === idx) {
    return;
  }

  // Collapse previously open marker, if any.
  if (currentOpenIdx !== null) {
    const prevDiv = document.getElementById(`markerItem-${currentOpenIdx}`);
    if (prevDiv) {
      const prevDesc = prevDiv.querySelector('.marker-description');
      prevDesc?.classList.remove('open');
    }
  }

  currentDesc.classList.add('open');
  currentOpenIdx = idx;
}

/**
 * Closes the marker description when the close button is clicked.
 *
 * @param {number} idx - Index of the marker.
 * @param {Event} event - The click event.
 */
function closeMarkerDescription(idx, event) {
  event.stopPropagation();
  const currentDiv = document.getElementById(`markerItem-${idx}`);
  if (!currentDiv) return;
  const currentDesc = currentDiv.querySelector('.marker-description');
  if (currentDesc) {
    currentDesc.classList.remove('open');
  }
  if (currentOpenIdx === idx) {
    currentOpenIdx = null;
    detailMap.flyTo(currentRegionData.coordinates, 13);
  }
}

/**
 * Pans the map to the marker's location and opens its popup.
 *
 * @param {number} idx - Index of the marker.
 * @param {Array} coords - Marker coordinates.
 */
function flyToMarkerAndOpenPopup(idx, coords) {
  detailMap.flyTo(coords, 18);
  const marker = markersLayer.getLayers()[idx];
  if (marker) {
    marker.openPopup();
  }
}

/**
 * Renders marker information into the side panel.
 *
 * @param {Array} markers - Array of marker objects.
 */
function renderMarkersInfo(markers) {
  const container = document.getElementById('detailTextContent');
  container.innerHTML = '';

  if (!markers || markers.length === 0) {
    container.innerHTML = '<p>No markers data found.</p>';
    return;
  }

  markers.forEach((mk, idx) => {
    const itemDiv = document.createElement('div');
    itemDiv.className = 'marker-item';
    itemDiv.id = `markerItem-${idx}`;

    // Build marker description HTML.
    let descHTML = `<p>${mk.text || ''}</p>`;
    if (mk.image && mk.imageAlt) {
      descHTML += `
        <div class="marker-image" style="margin-top: 1rem;">
          <img src="${mk.image}" alt="${mk.imageAlt}" style="max-width: 100%; height: auto;"/>
        </div>
      `;
    }
    if (mk.pdfTitle || mk.pdfAuthor || mk.pdfExcerpt) {
      descHTML += `
        <div class="pdf-info">
          ${mk.pdfTitle ? `<h4>${mk.pdfTitle}</h4>` : ''}
          ${mk.pdfAuthor ? `<p><em>${mk.pdfAuthor}</em></p>` : ''}
          ${mk.pdfExcerpt ? `${mk.pdfExcerpt}` : ''}
        </div>
      `;
    }
    if (mk.pdfUrl) {
      // descHTML += `
      //   <button class="pdf-button" data-pdf="${mk.pdfUrl}">
      //     Read Full Articles
      //   </button>
      // `;
    }

    // Insert close button inside the marker description.
    itemDiv.innerHTML = `
      <h3 class="marker-title">${mk.title}</h3>
      <div class="marker-description">
        ${descHTML}
        <button class="close-btn">^</button>
      </div>
    `;

    // On clicking the marker item, expand description and pan the map.
    itemDiv.addEventListener('click', () => {
      toggleMarkerDescription(idx);
      flyToMarkerAndOpenPopup(idx, mk.coordinates);
    });

    // Bind the close button event.
    const closeBtn = itemDiv.querySelector('.close-btn');
    if (closeBtn) {
    // get id detailTextContent's width
    const detailText = document.getElementById('detailTextContent');
      const detailTextWidth = detailText.offsetWidth;
      closeBtn.style.left = `${detailTextWidth - 60}px`;
      closeBtn.addEventListener('click', (e) => {
        closeMarkerDescription(idx, e);
      });
    }

    // Setup "Read Full Articles" button event.
    setTimeout(() => {
      const pdfBtn = itemDiv.querySelector('.pdf-button');
      if (pdfBtn) {
        pdfBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const pdfUrl = pdfBtn.getAttribute('data-pdf');
          openPdfModal(pdfUrl);
        });
      }
    }, 0);

    // Use IntersectionObserver to pan the map when a marker item is in view.
    const observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && window.parent?.scrollGuidedEnabled) {
        detailMap.flyTo(mk.coordinates, 12);
      }
    }, {
      root: container,
      threshold: 0.6
    });
    observer.observe(itemDiv);

    container.appendChild(itemDiv);
  });

  // Bind click events on highlighted markers for map panning.
  setTimeout(() => {
    const highlightElems = container.querySelectorAll('.marker-highlight');
    highlightElems.forEach(elem => {
      elem.addEventListener('click', (e) => {
        e.stopPropagation();
        const markerIdx = parseInt(elem.getAttribute('data-marker'), 10);
        if (!isNaN(markerIdx) && markers[markerIdx]) {
          flyToMarkerAndOpenPopup(markerIdx, markers[markerIdx].coordinates);
        }
      });
    });
  }, 0);
}

// ==============================
// Main Initialization & Event Listeners
// ==============================
document.addEventListener('DOMContentLoaded', async () => {
  // Create PDF modal.
  createPdfModal();

  // Retrieve regionId from URL parameters.
  const urlParams = new URLSearchParams(window.location.search);
  const regionId = parseInt(urlParams.get('id'), 10);

  // Fetch region data.
  const resp = await fetch('/data/mapsData.json');
  const data = await resp.json();

  // Find matching region data.
  currentRegionData = data.maps.find(m => m.id === regionId);
  if (!currentRegionData) {
    document.getElementById('regionTitle').textContent = "Region Not Found";
    return;
  }

  // Set region title.
  document.getElementById('regionTitle').textContent = currentRegionData.title;

  // Initialize the map with region data.
  initDetailMap(currentRegionData);

  // Process PDF text for markers (if available).
  if (currentRegionData.markers && currentRegionData.markers.length > 0) {
    await processMarkersPdfText(currentRegionData.markers);
  }

  // Render marker information.
  renderMarkersInfo(currentRegionData.markers);
});

// ==============================
// Window Resize Handler
// ==============================
let lastWindowWidth = window.innerWidth;
let resizeTimeout = null;
window.addEventListener('resize', () => {
  if (window.innerWidth !== lastWindowWidth) {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      location.reload();
    }, 300);
  }
});
