const axios = require("axios");
const redis = require('redis');

const MOVEMENT_THRESHOLD = 500; // Meters
const CACHE_EXPIRATION = 86400; // 24 hours

const client = redis.createClient();
client.connect();

function haversineDistance(lat1, lon1, lat2, lon2) {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const R = 6371000; // Radius of Earth in meters

    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return (R * c)/1000; // Distance in kilometers
}

const getHospitals = async (req, res) => {
    try {
        const { lat, lon, radius } = req.body;

        console.log("Received request to fetch hospitals near:", lat, lon, "with radius:", radius);

        // Validate inputs
        if (!lat || !lon || !radius) {
            console.log("Missing required parameters.");
            return res.status(400).json({ error: "Please provide latitude, longitude, and radius." });
        }

        // Check Redis for cached data
        const cacheKeys = await client.keys("hospitals:*"); // Get all cached locations

        for (const key of cacheKeys) {
            const cachedData = JSON.parse(await client.get(key));
            const [cachedLat, cachedLon, cachedRadius] = key.split(":").slice(1);

            // If user is within threshold distance & radius matches, return cached data
            if (haversineDistance(lat, lon, cachedLat, cachedLon) < MOVEMENT_THRESHOLD && radius == cachedRadius) {
                console.log("Returning cached data");
                console.log("Successfully fetched hospitals:", cachedData.length);
                return res.json({ hospitals: cachedData });
            }
        }

        console.log("Querying Overpass API...");
        const overpassQuery = `[out:json];node["amenity"="hospital"](around:${radius},${lat},${lon});out;`;
        const overpassUrl = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(overpassQuery)}`;

        const response = await axios.get(overpassUrl);
        const data = response.data;

        // Extract hospitals data
        const hospitals = data.elements
        .filter(hospital => hospital.tags && hospital.tags.name) // Ensure hospital has a name
        .map(hospital => ({
            id: String(hospital.id),
            name: hospital.tags.name,
            distance: String(haversineDistance(lat, lon, hospital.lat, hospital.lon)), // Fixed typo in "distance"
        }));

        // Store in Redis with 24-hour expiration
        const cacheKey = `hospitals:${lat}:${lon}:${radius}`;
        await client.setEx(cacheKey, CACHE_EXPIRATION, JSON.stringify(hospitals));
        console.log("Stored hospitals data in Redis cache.");

        console.log("Successfully fetched hospitals:", hospitals.length);
        res.json({ hospitals });

    } catch (error) {
        console.error("Error fetching hospitals:", error.message);
        res.status(500).json({ error: "An error occurred while fetching hospitals." });
    }
};

const getHospitalById = async (req, res) => {
    try {
        let { id, lat, lon } = req.query;
        id = Number(id); // Convert ID to number
        console.log("Received request to fetch hospital by ID:", id);

        // Validate input
        if (!id) {
            console.log("Missing hospital ID.");
            return res.status(400).json({ error: "Please provide a hospital ID." });
        }

        // Check Redis for cached data
        const cacheKey = `hospital:${id}`;
        const cachedData = await client.get(cacheKey);

        if (cachedData) {
            console.log("Returning cached hospital data");
            return res.status(200).json(JSON.parse(cachedData));
        }

        console.log("Querying Overpass API for hospital by ID...");
        const overpassQuery = `[out:json];node(${id});out;`;
        const overpassUrl = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(overpassQuery)}`;

        const response = await axios.get(overpassUrl);
        const data = response.data;

        const hospital = data.elements[0];
        if (!hospital) {
            console.log("Hospital not found.");
            return res.status(404).json({ error: "Hospital not found." });
        }

        const hospitalData = {
            id: hospital.id,
            name: hospital.tags.name || "Unknown Hospital",
            distance: haversineDistance(lat, lon, hospital.lat, hospital.lon)
        };

        // Store in Redis with 24-hour expiration
        await client.setEx(cacheKey, CACHE_EXPIRATION, JSON.stringify(hospitalData));
        console.log("Stored hospital data in Redis cache.");

        console.log("Successfully fetched hospital:", hospitalData);
        res.status(200).json(hospitalData);
    }
    catch (error) {
        console.error("Error fetching hospital by ID:", error.message);
        res.status(500).json({ error: "An error occurred while fetching the hospital." });
    }
}
module.exports = { getHospitals, getHospitalById };