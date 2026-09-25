# PlateScan AI integration

PlateScan AI is integrated into the Hostel (Donor) section.

Route: `/hostel-dashboard/platescan`

The NGO/Receiver section is unchanged.

## Setup
1. `npm install`
2. Copy `platescan-backend/.env.example` to `platescan-backend/.env`
3. Put the Nabh key in `NABH_API_KEY` (do not commit/share the key)
4. `npm run dev`
5. Open the Smart Food Waste Tracker locally.

The Vite dev server proxies `/api` to the PlateScan backend on port 4000.
