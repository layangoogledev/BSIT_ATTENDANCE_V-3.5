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
 * Averages 3 GPS readings for location spoof reduction
 */
export async function getVerifiedLocation() {
  const readings = [];
  for (let i = 0; i < 3; i++) {
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 5000 });
    });
    readings.push({ lat: pos.coords.latitude, lng: pos.coords.longitude });
    await new Promise(r => setTimeout(r, 500));
  }

  const avgLat = readings.reduce((sum, r) => sum + r.lat, 0) / 3;
  const avgLng = readings.reduce((sum, r) => sum + r.lng, 0) / 3;
  const distance = calculateHaversineDistance(avgLat, avgLng);

  return {
    latitude: avgLat,
    longitude: avgLng,
    distanceMeters: distance,
    isWithinFence: distance <= MAX_RADIUS_METERS
  };
}