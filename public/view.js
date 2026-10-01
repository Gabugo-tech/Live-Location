const params    = new URLSearchParams(window.location.search);
const sessionId = params.get('id');

if (!sessionId) window.location.href = '/';

// ── Leaflet map setup ──
const map = L.map('map', { zoomControl: true }).setView([0, 0], 2);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 19
}).addTo(map);

// Custom red marker icon
const markerIcon = L.divIcon({
  className: '',
  html: `<div style="
    width:18px;height:18px;
    background:#e94560;
    border:3px solid #fff;
    border-radius:50%;
    box-shadow:0 2px 8px rgba(0,0,0,0.5);
  "></div>`,
  iconSize: [18, 18],
  iconAnchor: [9, 9]
});

let marker         = null;
let accuracyCircle = null;
let firstFix       = true;

const overlay       = document.getElementById('overlay');
const bannerEl      = document.getElementById('last-known-banner');
const bannerTime    = document.getElementById('banner-time');
const statusDot     = document.getElementById('status-dot');
const statusText    = document.getElementById('topbar-status');
const coordsDisplay = document.getElementById('coords-display');
const infoLat       = document.getElementById('info-lat');
const infoLng       = document.getElementById('info-lng');
const infoAcc       = document.getElementById('info-acc');
const infoTime      = document.getElementById('info-time');

function formatTime(timestamp, tz) {
  try {
    return new Date(timestamp).toLocaleTimeString(undefined, tz ? { timeZone: tz } : {});
  } catch {
    return new Date(timestamp).toLocaleTimeString();
  }
}

function updateUI(lat, lng, accuracy, timestamp, isLastKnown = false, tz = null) {
  const latlng = [lat, lng];

  // Hide the waiting overlay
  overlay.classList.add('hidden');

  if (isLastKnown) {
    bannerEl.classList.add('visible');
    bannerTime.textContent = `Last seen ${formatTime(timestamp, tz)}`;
    statusDot.className    = 'dot last-known';
    statusText.textContent = 'Last known location';
  } else {
    bannerEl.classList.remove('visible');
    statusDot.className    = 'dot';
    statusText.textContent = 'Live — location updating';
  }

  coordsDisplay.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

  infoLat.textContent  = lat.toFixed(6);
  infoLng.textContent  = lng.toFixed(6);
  infoAcc.textContent  = accuracy ? `±${Math.round(accuracy)} m` : '—';
  infoTime.textContent = formatTime(timestamp, tz);

  if (!marker) {
    marker = L.marker(latlng, { icon: markerIcon }).addTo(map);
  } else {
    marker.setLatLng(latlng);
  }

  if (accuracy) {
    if (accuracyCircle) {
      accuracyCircle.setLatLng(latlng).setRadius(accuracy);
    } else {
      accuracyCircle = L.circle(latlng, {
        radius: accuracy,
        color: '#e94560',
        fillColor: '#e94560',
        fillOpacity: 0.12,
        weight: 1
      }).addTo(map);
    }
  }

  if (firstFix) {
    map.flyTo(latlng, 16, { duration: 1.5 });
    firstFix = false;
  } else if (!isLastKnown) {
    map.panTo(latlng, { animate: true, duration: 0.8 });
  }
}

// ── Socket.io — force WebSocket directly, skipping polling upgrade ──
const socket = io({ transports: ['websocket'] });
socket.emit('join-view', sessionId);

socket.on('location-update', ({ lat, lng, accuracy, timestamp, tz }) => {
  updateUI(lat, lng, accuracy, timestamp, false, tz || null);
});

socket.on('waiting', () => {
  overlay.classList.remove('hidden');
  bannerEl.classList.remove('visible');
  statusDot.className    = 'dot waiting';
  statusText.textContent = 'Waiting for sharer to connect...';
});

socket.on('sharing-stopped', (data) => {
  if (data && data.lat != null) {
    updateUI(data.lat, data.lng, data.accuracy, data.timestamp, true, data.tz || null);
  } else {
    bannerEl.classList.add('visible');
    bannerTime.textContent = '';
    statusDot.className    = 'dot stopped';
    statusText.textContent = 'Sharing stopped';
  }
});
