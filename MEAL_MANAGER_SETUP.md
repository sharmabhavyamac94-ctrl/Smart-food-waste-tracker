# Meal Manager changes

Navigation is now:
1. Overview & Analytics (combined)
2. Meal Entry
3. AI Analytics (AI Actions + AI Insights combined)
4. PlateScan AI
5. Impact & ESG
6. Food Logs

## Meal Entry
- Four meal types: Breakfast, Lunch, Evening Snacks, Dinner.
- Food Prepared, Plate Waste and Food Remaining are separate item-wise tables.
- Prepared weight is read from `/api/hardware/weight/latest`.
- Prepared phase can be locked.
- Remaining is captured into the same item rows.
- Overall accounting: Prepared - physical plate waste - untouched remaining = Net Consumed.
- With one physical load cell, total plate waste is physically measured once; food-level allocation is an estimate when derived from PlateScan.

## Raspberry Pi hardware API
Pi posts readings to:
`POST /api/hardware/weight`
with JSON `{ "weightKg": 0.500 }` and header `X-Pi-Device-Token`.

The website reads the latest value from:
`GET /api/hardware/weight/latest`

Set the same `PI_DEVICE_TOKEN` in the backend environment and on the Pi.

## PlateScan
PlateScan now uses meal types instead of user-facing rounds:
- Breakfast
- Lunch
- Evening Snacks
- Dinner

The backend keeps its legacy round number field internally for database compatibility, but the UI no longer asks the user to choose a round.
