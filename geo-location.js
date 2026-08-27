// Pampanga State University - Mexico Campus Coordinates (Default)
const CAMPUS_LAT = 15.0650;
const CAMPUS_LNG = 120.7200;
const MAX_RADIUS_METERS = 150;

/**
 * Calculates distance between two GPS coordinates using the Haversine formula
 */
export function calculateHaversineDistance(lat1, lon1, lat2 = CAMPUS_LAT, lon2 = CAMPUS_LNG) {
  const R = 6371e3; // Earth radius in meters
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;

  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * rad) * Math.cos(lat2 * rad) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // Returns distance in meters
}

/**
 * Averages up to 3 GPS readings for location spoof reduction.
 * Tolerant of a slow or failed individual reading — GPS often takes
 * longer than a few seconds to get a fix, especially indoors, so a
 * single timeout shouldn't fail the whole check-in. Only throws if
 * every attempt fails.
 */
export async function getVerifiedLocation() {
  const readings = [];
  const attempts = 3;

  for (let i = 0; i < attempts; i++) {
    try {
      const pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 15000, // was 5000 — too short for a real GPS fix, especially indoors
          maximumAge: 10000 // allow reusing a very recent cached fix instead of forcing a fresh one every time
        });
      });
      readings.push({ lat: pos.coords.latitude, lng: pos.coords.longitude });
    } catch (err) {
      // Keep going — we only need at least one successful reading.
      // Only surface an error if every attempt fails (handled below).
    }
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  if (readings.length === 0) {
    throw new Error(
      "Couldn't get your location. Make sure location access is allowed for this site and you have a clear GPS signal, then try again."
    );
  }

  const avgLat = readings.reduce((sum, r) => sum + r.lat, 0) / readings.length;
  const avgLng = readings.reduce((sum, r) => sum + r.lng, 0) / readings.length;
  const distance = calculateHaversineDistance(avgLat, avgLng);

  return {
    latitude: avgLat,
    longitude: avgLng,
    distanceMeters: distance,
    isWithinFence: distance <= MAX_RADIUS_METERS
  };
}
