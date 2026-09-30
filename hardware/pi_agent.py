#!/usr/bin/env python
# Raspberry Pi 3 / Python 2.7 compatible starter agent.
# Wire HX711 according to your module/load-cell setup and calibrate before use.
import os, time, json
try:
    import requests
except ImportError:
    requests = None

BACKEND_URL = os.environ.get('PLATESCAN_BACKEND_URL', 'http://localhost:4000').rstrip('/')
PI_DEVICE_TOKEN = os.environ.get('PI_DEVICE_TOKEN', '')

# Replace this function with your calibrated HX711 reader.
def read_weight_kg():
    raise NotImplementedError('Connect your HX711 library/calibration here.')

def push_weight(kg):
    if requests is None:
        raise RuntimeError('Install requests: pip install requests')
    r = requests.post(BACKEND_URL + '/api/hardware/weight', headers={'X-Pi-Device-Token': PI_DEVICE_TOKEN}, json={'weightKg': float(kg)}, timeout=5)
    r.raise_for_status()
    return r.json()

if __name__ == '__main__':
    print('PlateScan Pi hardware agent started. Configure HX711 read_weight_kg() first.')
    while True:
        try:
            kg = read_weight_kg()
            print('Weight: %.3f kg' % kg)
            push_weight(kg)
        except Exception as exc:
            print('Hardware agent:', exc)
        time.sleep(1.0)
