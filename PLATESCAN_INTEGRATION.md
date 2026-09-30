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


## Raspberry Pi USB webcam

The PlateScan page now uses the Raspberry Pi MJPEG stream by default.

1. Copy `hardware/camera_server.py` to the Raspberry Pi.
2. Install dependencies on the Pi if needed:
   `python3 -m pip install flask opencv-python`
3. Start the stream:
   `python3 camera_server.py`
4. Verify from the laptop:
   `http://<PI-IP>:5000/video`
5. Set `VITE_PI_CAMERA_URL` to the same Pi URL before building/deploying.
6. Keep the laptop/phone and Raspberry Pi on the same Wi-Fi/LAN.

The Pi stream includes CORS headers because PlateScan captures frames from the live stream in a browser canvas for automatic scanning.

Note: if the deployed website is HTTPS, browsers can block an HTTP Pi stream as mixed content. For a deployed HTTPS site, the Pi stream must also be exposed through HTTPS (or the frontend must be served in a compatible local/LAN setup).
