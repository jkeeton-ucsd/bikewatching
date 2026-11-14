// ============================================================
// Step 1.1 / 3: import libraries as ES modules
// ============================================================
import mapboxgl from 'https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm';
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';

console.log('Mapbox GL JS Loaded:', mapboxgl);

// ============================================================
// Step 1.3: create the map
// ============================================================
// Paste your PUBLIC token (starts with "pk.") from https://account.mapbox.com
mapboxgl.accessToken = 'pk.eyJ1IjoiamtlZXRvbi11Y3NkIiwiYSI6ImNtd2dxdjNnYzBiMWIyeXBqcWVrY3p6cnQifQ.cAQNoPGX8JfCwAnVhiIuMw';

const map = new mapboxgl.Map({
  container: 'map', // id of the <div>
  style: 'mapbox://styles/mapbox/streets-v12', // swap for a Studio style URL (Step 1.5)
  center: [-71.09415, 42.36027], // [lng, lat] — Mapbox wants LONGITUDE first
  zoom: 12,
  minZoom: 5,
  maxZoom: 18,
});

// ============================================================
// Data URLs
// ============================================================
const BOSTON_LANES_URL =
  'https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson';
const CAMBRIDGE_LANES_URL =
  'https://raw.githubusercontent.com/cambridgegis/cambridgegis_data/main/Recreation/Bike_Facilities/RECREATION_BikeFacilities.geojson';
const STATIONS_URL = 'https://dsc106.com/labs/lab07/data/bluebikes-stations.json';
const TRIPS_URL = 'https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv';

// Step 2.3 "Going further": one shared style object for both lane layers
const bikeLanePaint = {
  'line-color': '#32D400',
  'line-width': 3,
  'line-opacity': 0.5,
};

// ============================================================
// Step 5.4: pre-bucket trips by minute of day (0..1439)
// ============================================================
let departuresByMinute = Array.from({ length: 1440 }, () => []);
let arrivalsByMinute = Array.from({ length: 1440 }, () => []);

// ============================================================
// Global helpers
// ============================================================

// Step 3.3: lon/lat -> pixel position inside the map container
function getCoords(station) {
  const point = new mapboxgl.LngLat(+station.lon, +station.lat);
  const { x, y } = map.project(point); // accounts for pan, zoom, rotation
  return { cx: x, cy: y };
}

// Step 5.2: minutes since midnight -> "8:30 AM"
function formatTime(minutes) {
  const date = new Date(0, 0, 0, 0, minutes);
  return date.toLocaleString('en-US', { timeStyle: 'short' });
}

// Step 5.3
function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

// Step 5.4: grab trips within ±60 min using the buckets (handles wrap past midnight)
function filterByMinute(tripsByMinute, minute) {
  if (minute === -1) {
    return tripsByMinute.flat(); // no filtering
  }

  const minMinute = (minute - 60 + 1440) % 1440;
  const maxMinute = (minute + 60) % 1440;

  if (minMinute > maxMinute) {
    // window crosses midnight, e.g. 11:30 PM -> 12:30 AM
    const beforeMidnight = tripsByMinute.slice(minMinute);
    const afterMidnight = tripsByMinute.slice(0, maxMinute);
    return beforeMidnight.concat(afterMidnight).flat();
  }
  return tripsByMinute.slice(minMinute, maxMinute).flat();
}

// Step 4.2 -> refactored in 5.3 -> optimized in 5.4
function computeStationTraffic(stations, timeFilter = -1) {
  const departures = d3.rollup(
    filterByMinute(departuresByMinute, timeFilter),
    (v) => v.length,
    (d) => d.start_station_id,
  );

  const arrivals = d3.rollup(
    filterByMinute(arrivalsByMinute, timeFilter),
    (v) => v.length,
    (d) => d.end_station_id,
  );

  return stations.map((station) => {
    const id = station.short_name; // trips reference stations by short_name
    station.arrivals = arrivals.get(id) ?? 0;
    station.departures = departures.get(id) ?? 0;
    station.totalTraffic = station.arrivals + station.departures;
    return station;
  });
}

// Step 6.1: continuous ratio [0,1] -> one of three buckets {0, 0.5, 1}
const stationFlow = d3.scaleQuantize().domain([0, 1]).range([0, 0.5, 1]);

function departureRatio(d) {
  // NOTE (fix): a station with 0 trips would give 0/0 = NaN -> treat as balanced
  return d.totalTraffic ? stationFlow(d.departures / d.totalTraffic) : 0.5;
}

function tooltipText(d) {
  return `${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`;
}

// ============================================================
// Everything that needs the map to be ready
// ============================================================
map.on('load', async () => {
  // ---------- Step 2: bike lanes as native Mapbox layers ----------
  map.addSource('boston_route', { type: 'geojson', data: BOSTON_LANES_URL });
  map.addLayer({
    id: 'bike-lanes-boston',
    type: 'line',
    source: 'boston_route',
    paint: bikeLanePaint,
  });

  map.addSource('cambridge_route', { type: 'geojson', data: CAMBRIDGE_LANES_URL });
  map.addLayer({
    id: 'bike-lanes-cambridge',
    type: 'line',
    source: 'cambridge_route',
    paint: bikeLanePaint,
  });

  // ---------- Step 3.1 + 4.1: load stations and trips ----------
  // NOTE (fix): the PDF re-declares `const jsonData` inside try{}, which shadows
  // the outer variable and leaves it undefined afterwards. Assign instead.
  let jsonData;
  let trips;
  try {
    jsonData = await d3.json(STATIONS_URL);
    console.log('Loaded JSON Data:', jsonData);

    // The 2nd argument to d3.csv runs once per row as it's parsed.
    // We use it to (a) turn date strings into Date objects and
    // (b) drop each trip into its minute bucket (Step 5.4).
    trips = await d3.csv(TRIPS_URL, (trip) => {
      trip.started_at = new Date(trip.started_at);
      trip.ended_at = new Date(trip.ended_at);

      departuresByMinute[minutesSinceMidnight(trip.started_at)].push(trip);
      arrivalsByMinute[minutesSinceMidnight(trip.ended_at)].push(trip);

      return trip;
    });
    console.log(`Loaded ${trips.length} trips`);
  } catch (error) {
    console.error('Error loading data:', error);
    return;
  }

  // ---------- Step 4.2: traffic per station (all times) ----------
  const stations = computeStationTraffic(jsonData.data.stations);
  console.log('Stations Array:', stations);

  // ---------- Step 4.3: sqrt scale so circle AREA ∝ traffic ----------
  const radiusScale = d3
    .scaleSqrt()
    .domain([0, d3.max(stations, (d) => d.totalTraffic)])
    .range([0, 25]);

  // ---------- Step 3.3: one SVG circle per station ----------
  const svg = d3.select('#map').select('svg');

  const circles = svg
    .selectAll('circle')
    .data(stations, (d) => d.short_name) // key fn: match circles to stations by id
    .enter()
    .append('circle')
    .attr('r', (d) => radiusScale(d.totalTraffic))
    .style('--departure-ratio', departureRatio) // Step 6.1 (color is done in CSS)
    .each(function (d) {
      // Step 4.4: native browser tooltip
      d3.select(this).append('title').text(tooltipText(d));
    });

  // ---------- Step 3.3: keep circles glued to the map ----------
  function updatePositions() {
    circles
      .attr('cx', (d) => getCoords(d).cx)
      .attr('cy', (d) => getCoords(d).cy);
  }

  updatePositions();
  map.on('move', updatePositions);
  map.on('zoom', updatePositions);
  map.on('resize', updatePositions);
  map.on('moveend', updatePositions);

  // ---------- Step 5.2: wire up the slider ----------
  // NOTE (fix): getElementById takes a bare id — no '#'.
  const timeSlider = document.getElementById('time-slider');
  const selectedTime = document.getElementById('selected-time');
  const anyTimeLabel = document.getElementById('any-time');

  // ---------- Step 5.3: re-filter + resize/recolor on change ----------
  function updateScatterPlot(timeFilter) {
    const filteredStations = computeStationTraffic(stations, timeFilter);

    // bigger circles when showing a 2-hour slice, so they stay visible
    timeFilter === -1 ? radiusScale.range([0, 25]) : radiusScale.range([3, 50]);

    circles
      .data(filteredStations, (d) => d.short_name)
      .join('circle')
      .attr('r', (d) => radiusScale(d.totalTraffic))
      .style('--departure-ratio', departureRatio);

    // keep tooltips in sync with the filter (not in the PDF, but otherwise they go stale)
    circles.select('title').text(tooltipText);
  }

  function updateTimeDisplay() {
    const timeFilter = Number(timeSlider.value);

    if (timeFilter === -1) {
      selectedTime.textContent = '';
      anyTimeLabel.style.display = 'block';
    } else {
      selectedTime.textContent = formatTime(timeFilter);
      anyTimeLabel.style.display = 'none';
    }

    updateScatterPlot(timeFilter);
  }

  timeSlider.addEventListener('input', updateTimeDisplay);
  updateTimeDisplay();
});
