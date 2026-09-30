#!/usr/bin/env python3
"""
Raspberry Pi USB webcam -> MJPEG HTTP stream for PlateScan.

Run:
    python3 camera_server.py

Then open from another device on the same Wi-Fi:
    http://<PI-IP>:5000/video
"""
from flask import Flask, Response, jsonify
import cv2
import time

app = Flask(__name__)

CAMERA_INDEX = 0
WIDTH = 640
HEIGHT = 480
FPS = 20
JPEG_QUALITY = 80

camera = cv2.VideoCapture(CAMERA_INDEX)
camera.set(cv2.CAP_PROP_FRAME_WIDTH, WIDTH)
camera.set(cv2.CAP_PROP_FRAME_HEIGHT, HEIGHT)
camera.set(cv2.CAP_PROP_FPS, FPS)

if not camera.isOpened():
    raise RuntimeError("Could not open USB webcam. Check that the Logitech webcam is connected.")

def mjpeg_frames():
    while True:
        ok, frame = camera.read()
        if not ok:
            time.sleep(0.1)
            continue

        ok, jpg = cv2.imencode(
            ".jpg",
            frame,
            [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_QUALITY],
        )
        if not ok:
            continue

        yield (
            b"--frame\r\n"
            b"Content-Type: image/jpeg\r\n"
            b"Cache-Control: no-cache, no-store, must-revalidate\r\n"
            b"Pragma: no-cache\r\n"
            b"\r\n" + jpg.tobytes() + b"\r\n"
        )

@app.after_request
def add_cors(response):
    # Required because PlateScan reads frames from this stream with canvas.
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response

@app.get("/")
def home():
    return jsonify({
        "ok": True,
        "service": "PlateScan Raspberry Pi webcam",
        "stream": "/video",
    })

@app.get("/health")
def health():
    return jsonify({"ok": camera.isOpened()})

@app.get("/video")
def video():
    return Response(
        mjpeg_frames(),
        mimetype="multipart/x-mixed-replace; boundary=frame",
    )

if __name__ == "__main__":
    try:
        print("PlateScan Pi webcam server starting...")
        print("Open http://<PI-IP>:5000/video from a device on the same Wi-Fi.")
        app.run(host="0.0.0.0", port=5000, threaded=True)
    finally:
        camera.release()
