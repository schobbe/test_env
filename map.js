// Default view coordinates and zoom level (centered on world)
const DEFAULT_CENTER = [20, 0];
const DEFAULT_ZOOM = 2;

// Initialize the map
const map = L.map('map', {
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    minZoom: 2,
    maxZoom: 18,
    worldCopyJump: true
});

// Tile Layer 1: OpenStreetMap Standard (100% free, no API key, borders and labels)
const osmLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors'
}).addTo(map);

// Tile Layer 2: OpenTopoMap (Clean topographic terrain + borders, free)
const topoLayer = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17,
    attribution: 'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a>'
});

// Base map layer control (Free layers only)
const baseMaps = {
    "OpenStreetMap (Standard)": osmLayer,
    "Topographic (OpenTopoMap)": topoLayer
};

L.control.layers(baseMaps, null, { position: 'topright' }).addTo(map);

// Add scale bar
L.control.scale({ imperial: true, metric: true, position: 'bottomright' }).addTo(map);

// Active marker tracker
let currentMarker = null;

// RainViewer Live Radar Tile Layer tracker
let radarLayer = null;

// WMO Weather code interpreter table
function getWeatherDetails(code) {
    const codes = {
        0: { desc: "Clear sky", icon: "☀️" },
        1: { desc: "Mainly clear", icon: "🌤️" },
        2: { desc: "Partly cloudy", icon: "⛅" },
        3: { desc: "Overcast", icon: "☁️" },
        45: { desc: "Foggy", icon: "🌫️" },
        48: { desc: "Depositing rime fog", icon: "🌫️" },
        51: { desc: "Light drizzle", icon: "🌦️" },
        53: { desc: "Moderate drizzle", icon: "🌦️" },
        55: { desc: "Dense drizzle", icon: "🌧️" },
        61: { desc: "Slight rain", icon: "🌧️" },
        63: { desc: "Moderate rain", icon: "🌧️" },
        65: { desc: "Heavy rain", icon: "⛈️" },
        71: { desc: "Slight snowfall", icon: "🌨️" },
        73: { desc: "Moderate snowfall", icon: "🌨️" },
        75: { desc: "Heavy snowfall", icon: "❄️" },
        80: { desc: "Slight rain showers", icon: "🌦️" },
        81: { desc: "Moderate rain showers", icon: "🌧️" },
        82: { desc: "Violent rain showers", icon: "⛈️" },
        95: { desc: "Thunderstorm", icon: "⚡" },
        96: { desc: "Thunderstorm with slight hail", icon: "⛈️" },
        99: { desc: "Thunderstorm with heavy hail", icon: "⛈️" }
    };
    return codes[code] || { desc: "Variable conditions", icon: "🌡️" };
}


// Fetch real-time weather from Open-Meteo (No API key needed)
async function fetchRealTimeWeather(lat, lng, locationLabel = "") {
    const loadingElem = document.getElementById('weatherLoading');
    if (loadingElem) loadingElem.style.display = 'inline';

    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m&timezone=auto`;
        const response = await fetch(url);
        if (!response.ok) throw new Error("Weather request failed");
        
        const data = await response.json();
        const current = data.current;
        const elevation = data.elevation !== undefined ? data.elevation : "--";
        const weatherInfo = getWeatherDetails(current.weather_code);

        // Update Sidebar elements
        document.getElementById('weatherTemp').textContent = Math.round(current.temperature_2m);
        document.getElementById('weatherIcon').textContent = weatherInfo.icon;
        document.getElementById('weatherDesc').textContent = weatherInfo.desc;
        document.getElementById('weatherCoords').textContent = locationLabel 
            ? `${locationLabel} (${lat}°, ${lng}°)` 
            : `Coordinates: ${lat}°, ${lng}°`;
        document.getElementById('weatherWind').textContent = `${current.wind_speed_10m} km/h`;
        document.getElementById('weatherWindDir').textContent = `${current.wind_direction_10m}°`;
        document.getElementById('weatherHumidity').textContent = `${current.relative_humidity_2m}%`;
        document.getElementById('weatherElevation').textContent = `${elevation} m`;

        return {
            temp: Math.round(current.temperature_2m),
            desc: weatherInfo.desc,
            icon: weatherInfo.icon,
            wind: current.wind_speed_10m,
            humidity: current.relative_humidity_2m
        };
    } catch (err) {
        console.error("Error fetching weather:", err);
        document.getElementById('weatherDesc').textContent = "Weather unavailable for location";
        return null;
    } finally {
        if (loadingElem) loadingElem.style.display = 'none';
    }
}


// Handle map clicks
map.on('click', async function(e) {
    const lat = Number(e.latlng.lat.toFixed(4));
    const lng = Number(e.latlng.lng.toFixed(4));

    // Update raw coordinates panel
    const rawCoords = document.getElementById('rawCoordsText');
    if (rawCoords) {
        rawCoords.innerHTML = `Lat: <strong>${lat}°</strong><br>Lng: <strong>${lng}°</strong>`;
    }

    // Move or place marker
    if (!currentMarker) {
        currentMarker = L.marker([lat, lng]).addTo(map);
    } else {
        currentMarker.setLatLng([lat, lng]);
    }

    currentMarker.bindPopup(`
        <div style="font-family: inherit; font-size: 13px; line-height: 1.5;">
            <b>Pin Location:</b> ${lat}°, ${lng}°<br>
            <i>Fetching live weather...</i>
        </div>
    `).openPopup();

    // Fetch live weather data
    const weather = await fetchRealTimeWeather(lat, lng);
    if (weather) {
        currentMarker.bindPopup(`
            <div style="font-family: inherit; font-size: 13px; min-width: 140px;">
                <div style="font-size: 16px; font-weight: bold; margin-bottom: 4px;">
                    ${weather.icon} ${weather.temp}°C
                </div>
                <div><b>Condition:</b> ${weather.desc}</div>
                <div><b>Wind:</b> ${weather.wind} km/h</div>
                <div><b>Humidity:</b> ${weather.humidity}%</div>
            </div>
        `).openPopup();
    }
});

// Quick jump to major cities
async function jumpToCity(lat, lng, name) {
    map.flyTo([lat, lng], 8, { duration: 1.4 });

    const rawCoords = document.getElementById('rawCoordsText');
    if (rawCoords) {
        rawCoords.innerHTML = `<strong>${name}</strong><br>Lat: ${lat}° | Lng: ${lng}°`;
    }

    if (!currentMarker) {
        currentMarker = L.marker([lat, lng]).addTo(map);
    } else {
        currentMarker.setLatLng([lat, lng]);
    }

    const weather = await fetchRealTimeWeather(lat, lng, name);
    if (weather) {
        currentMarker.bindPopup(`
            <div style="font-family: inherit; font-size: 13px; min-width: 140px;">
                <div style="font-size: 15px; font-weight: bold; color: #4338ca;">${name}</div>
                <div style="font-size: 16px; font-weight: bold; margin: 4px 0;">
                    ${weather.icon} ${weather.temp}°C
                </div>
                <div><b>Condition:</b> ${weather.desc}</div>
                <div><b>Wind:</b> ${weather.wind} km/h</div>
                <div><b>Humidity:</b> ${weather.humidity}%</div>
            </div>
        `).openPopup();
    }
}

// Reset Map View
function resetMapView() {
    map.flyTo(DEFAULT_CENTER, DEFAULT_ZOOM, { duration: 1.2 });
}

// RainViewer Live Precipitation Radar Toggle (100% Free, no API key)
async function toggleRadarOverlay(enable) {
    const badge = document.getElementById('radarBadge');

    if (!enable) {
        if (radarLayer) {
            map.removeLayer(radarLayer);
            radarLayer = null;
        }
        if (badge) badge.classList.remove('active');
        return;
    }

    try {
        if (badge) {
            badge.textContent = "Loading radar...";
            badge.classList.add('active');
        }
        const res = await fetch('https://api.rainviewer.com/public/weather-maps.json');
        const data = await res.json();
        
        if (data && data.radar && data.radar.past && data.radar.past.length > 0) {
            const latestPast = data.radar.past[data.radar.past.length - 1];
            const radarPath = latestPast.path;
            const tileUrl = `https://tilecache.rainviewer.com${radarPath}/256/{z}/{x}/{y}/2/1_1.png`;

            if (radarLayer) {
                map.removeLayer(radarLayer);
            }

            radarLayer = L.tileLayer(tileUrl, {
                opacity: 0.65,
                zIndex: 100,
                attribution: '&copy; <a href="https://www.rainviewer.com" target="_blank">RainViewer</a>'
            }).addTo(map);

            if (badge) {
                badge.innerHTML = `<span class="pulsing-dot"></span><span>Live Rain Radar Active</span>`;
                badge.classList.add('active');
            }
        }
    } catch (err) {
        console.error("Error loading RainViewer radar:", err);
        if (badge) badge.textContent = "Radar unavailable";
    }
}

// Initialize with a default location (Berlin)
jumpToCity(52.5200, 13.4050, 'Berlin, Germany');

