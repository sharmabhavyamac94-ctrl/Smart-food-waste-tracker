import { useEffect, useState, useRef, useMemo } from 'react';
import { db } from '../config/firebase';
import {
  collection,
  query,
  where,
  onSnapshot,
  updateDoc,
  doc,
  getDocs,
  serverTimestamp,
} from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import {
  requestNotificationPermission,
  sendNotification,
} from '../utils/notifications.jsx';

/* =========================================================
   HELPERS
========================================================= */

const deg2rad = (d) => d * (Math.PI / 180);

const calcDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371;
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(deg2rad(lat1)) *
      Math.cos(deg2rad(lat2)) *
      Math.sin(dLon / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const normalizeCoords = (value) => {
  if (!value) return null;

  const lat = Number(value.lat ?? value.latitude);
  const lng = Number(value.lng ?? value.longitude ?? value.lon);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  return { lat, lng };
};

const getDonorCoords = (item) =>
  normalizeCoords(
    item?.donorLocation ||
      item?.location ||
      item?.donorCoordinates ||
      item?.coordinates
  );

const getNgoCoords = (userData) =>
  normalizeCoords(userData?.location) ||
  normalizeCoords(userData?.coordinates) ||
  normalizeCoords({ lat: userData?.lat, lng: userData?.lng });

const getFoodWeightKg = (item) => {
  if (!item) return 0;

  const candidates = [
    item.quantityKg,
    item.remainingKg,
    item.quantityValue,
  ];

  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }

  const unit = String(item.quantityUnit || item.unit || '').toLowerCase();

  if (['kg', 'kgs', 'kilogram', 'kilograms'].includes(unit)) {
    const n = Number(item.quantity);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  return 0;
};

const formatWeight = (kg) => {
  const n = Number(kg) || 0;
  if (n === 0) return '0.00 kg';
  if (n < 1) return `${(n * 1000).toFixed(0)} g`;
  return `${n.toFixed(2)} kg`;
};

const getEtaMinutes = (item) => {
  const saved = Number(item?.etaMinutes);
  if (Number.isFinite(saved) && saved > 0) return Math.round(saved);

  const distance = Number(item?.distance ?? item?.distanceKm);
  if (!Number.isFinite(distance) || distance < 0) return null;

  const AVERAGE_SPEED_KMPH = 30;
  return Math.max(5, Math.round((distance / AVERAGE_SPEED_KMPH) * 60));
};

const formatEta = (minutes) => {
  if (minutes === null || minutes === undefined || !Number.isFinite(Number(minutes))) {
    return 'ETA unavailable';
  }

  const mins = Math.max(0, Math.round(Number(minutes)));
  if (mins < 60) return `~${mins} min`;

  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `~${h} hr` : `~${h} hr ${m} min`;
};

const getPriority = (etaMinutes) => {
  if (etaMinutes == null) {
    return {
      label: 'Unknown',
      color: '#6b7280',
      bg: '#f3f4f6',
      dot: '⚪',
    };
  }

  if (etaMinutes <= 30) {
    return {
      label: 'High',
      color: '#dc2626',
      bg: '#fef2f2',
      dot: '🔴',
    };
  }

  if (etaMinutes <= 60) {
    return {
      label: 'Medium',
      color: '#d97706',
      bg: '#fffbeb',
      dot: '🟡',
    };
  }

  return {
    label: 'Low',
    color: '#059669',
    bg: '#ecfdf5',
    dot: '🟢',
  };
};

const getUrgencyData = (expiryTime, now) => {
  if (!expiryTime) {
    return { label: '', expired: false, type: 'success', pct: 100 };
  }

  const expiry = new Date(expiryTime);
  const diffMs = expiry - now;

  if (diffMs <= 0) {
    return { label: 'Expired', expired: true, type: 'danger', pct: 0 };
  }

  const diffMins = Math.floor(diffMs / 60000);
  const h = Math.floor(diffMins / 60);
  const m = diffMins % 60;

  return {
    label: `${h > 0 ? `${h}h ` : ''}${m}m left`,
    expired: false,
    type: h < 1 ? 'warning' : 'success',
    pct: Math.min(100, Math.round((diffMins / 180) * 100)),
  };
};

const toMs = (value) => {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value.toDate) return value.toDate().getTime();

  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? 0 : ms;
};

const fmtDateTime = (value) => {
  const ms = toMs(value);
  if (!ms) return 'Not recorded';

  return new Date(ms).toLocaleString([], {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const fmtTime = (value) => {
  const ms = toMs(value);
  if (!ms) return 'Not recorded';

  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
};

const getDurationMinutes = (start, end) => {
  const a = toMs(start);
  const b = toMs(end);
  if (!a || !b || b < a) return null;
  return Math.max(0, Math.round((b - a) / 60000));
};

const formatDuration = (minutes) => {
  if (minutes == null) return 'Not recorded';
  if (minutes < 60) return `${minutes} min`;

  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
};

const getStatusLabel = (status) => {
  if (status === 'Completed') return 'Delivered';
  return status || 'Unknown';
};

/* =========================================================
   UI HELPERS
========================================================= */

const StatCard = ({ label, value, color, icon, sub }) => (
  <div
    style={{
      background: '#fff',
      borderRadius: 12,
      padding: '1.1rem 1.25rem',
      borderLeft: `4px solid ${color}`,
      boxShadow: '0 1px 4px rgba(0,0,0,0.07)',
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
    }}
  >
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span
        style={{
          fontSize: '0.7rem',
          fontWeight: 700,
          color: '#6b7280',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: '1.25rem' }}>{icon}</span>
    </div>
    <div style={{ fontSize: '1.65rem', fontWeight: 800, color, lineHeight: 1.1 }}>{value}</div>
    {sub && <div style={{ fontSize: '0.75rem', color: '#9ca3af' }}>{sub}</div>}
  </div>
);

const UrgencyBar = ({ pct, type }) => {
  const color =
    type === 'danger' ? '#ef4444' : type === 'warning' ? '#f59e0b' : '#10b981';

  return (
    <div style={{ height: 4, background: '#f3f4f6', borderRadius: 2, overflow: 'hidden', marginBottom: 12 }}>
      <div
        style={{
          width: `${pct}%`,
          height: '100%',
          background: color,
          borderRadius: 2,
          transition: 'width 0.4s',
        }}
      />
    </div>
  );
};

const InfoCell = ({ label, value }) => (
  <div>
    <div
      style={{
        fontSize: '0.62rem',
        color: '#9ca3af',
        fontWeight: 700,
        textTransform: 'uppercase',
        marginBottom: 2,
      }}
    >
      {label}
    </div>
    <div style={{ fontSize: '0.84rem', fontWeight: 700, color: '#111827' }}>
      {value}
    </div>
  </div>
);

/* =========================================================
   AVAILABLE CARD
========================================================= */

const AvailableCard = ({ item, onAccept, now }) => {
  const urgency = getUrgencyData(item.expiryTime, now);
  const eta = getEtaMinutes(item);
  const priority = getPriority(eta);
  const weight = getFoodWeightKg(item);
  const donorCoords = getDonorCoords(item);
  const [accepting, setAccepting] = useState(false);

  const mapsUrl = donorCoords
    ? `https://www.google.com/maps/dir/?api=1&destination=${donorCoords.lat},${donorCoords.lng}&travelmode=driving`
    : null;

  const handleAccept = async () => {
    setAccepting(true);
    try {
      await onAccept(item);
    } finally {
      setAccepting(false);
    }
  };

  return (
    <div
      style={{
        background: '#fff',
        borderRadius: 14,
        boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
        overflow: 'hidden',
        border: '1px solid #e5e7eb',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ height: 4, background: `linear-gradient(90deg, ${priority.color}, #10b981)` }} />

      <div style={{ padding: '1rem 1.1rem 0' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start', marginBottom: 6 }}>
          <span
            style={{
              fontSize: '0.65rem',
              fontWeight: 700,
              padding: '2px 8px',
              borderRadius: 20,
              background: priority.bg,
              color: priority.color,
              whiteSpace: 'nowrap',
            }}
          >
            {priority.dot} {priority.label} ETA Priority
          </span>

          <span
            style={{
              fontSize: '0.65rem',
              fontWeight: 700,
              padding: '2px 8px',
              borderRadius: 20,
              background: '#dcfce7',
              color: '#166534',
              whiteSpace: 'nowrap',
            }}
          >
            ✅ Available
          </span>
        </div>

        <h3 style={{ fontSize: '0.95rem', fontWeight: 700, color: '#111827', marginBottom: 3 }}>
          {item.title || 'Food Donation'}
        </h3>

        <p style={{ fontSize: '0.78rem', color: '#6b7280', marginBottom: 10 }}>
          🏫 {item.hostelName || item.donorName || 'Hostel'}
          {' · '}
          {item.distance != null ? `📍 ${item.distance.toFixed(1)} km away` : '📍 Distance unavailable'}
        </p>

        <div
          style={{
            background: priority.bg,
            border: `1px solid ${priority.color}33`,
            borderRadius: 9,
            padding: '9px 11px',
            marginBottom: 10,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div>
            <div style={{ fontSize: '0.62rem', color: '#6b7280', fontWeight: 700, textTransform: 'uppercase' }}>
              Estimated Arrival
            </div>
            <div style={{ fontSize: '1rem', fontWeight: 800, color: priority.color, marginTop: 2 }}>
              ⏱ {formatEta(eta)}
            </div>
          </div>
          <div style={{ fontSize: '0.7rem', color: '#6b7280', textAlign: 'right' }}>
            Travel time
            <br />
            estimate
          </div>
        </div>

        {item.expiryTime && (
          <>
            <UrgencyBar pct={urgency.pct} type={urgency.type} />
            <div
              style={{
                fontSize: '0.75rem',
                fontWeight: 600,
                color:
                  urgency.type === 'danger'
                    ? '#ef4444'
                    : urgency.type === 'warning'
                    ? '#f59e0b'
                    : '#059669',
                marginBottom: 10,
              }}
            >
              ⏳ {urgency.label}
            </div>
          </>
        )}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 8,
            background: '#f9fafb',
            borderRadius: 8,
            padding: '10px 12px',
            marginBottom: 12,
            border: '1px solid #f3f4f6',
          }}
        >
          <InfoCell label="Food Weight" value={formatWeight(weight)} />
          <InfoCell label="ETA" value={formatEta(eta)} />
          <InfoCell label="Location" value={item.locationName || item.donorLocationName || 'Donor Location'} />
          <InfoCell label="Posted" value={fmtTime(item.createdAt)} />
        </div>
      </div>

      <div style={{ padding: '0 1.1rem 1rem', marginTop: 'auto' }}>
        {mapsUrl && (
          <a
            href={mapsUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              fontSize: '0.78rem',
              fontWeight: 600,
              color: '#3b82f6',
              padding: '7px 0',
              border: '1px solid #bfdbfe',
              borderRadius: 8,
              marginBottom: 8,
              textDecoration: 'none',
              background: '#eff6ff',
            }}
          >
            🗺️ Get Directions
          </a>
        )}

        <button
          onClick={handleAccept}
          disabled={urgency.expired || accepting}
          style={{
            width: '100%',
            padding: '10px 0',
            borderRadius: 8,
            fontWeight: 700,
            fontSize: '0.9rem',
            background: urgency.expired ? '#9ca3af' : 'linear-gradient(135deg, #10b981, #059669)',
            color: '#fff',
            cursor: urgency.expired || accepting ? 'not-allowed' : 'pointer',
            border: 'none',
            opacity: accepting ? 0.7 : 1,
          }}
        >
          {accepting ? '⏳ Accepting…' : urgency.expired ? '⛔ Unavailable' : '🤝 Accept Pickup'}
        </button>
      </div>
    </div>
  );
};

/* =========================================================
   ACCEPTED / IN-TRANSIT CARD
========================================================= */

const AcceptedCard = ({ item, onMarkPickedUp, onMarkDelivered, now }) => {
  const urgency = getUrgencyData(item.expiryTime, now);
  const eta = getEtaMinutes(item);
  const priority = getPriority(eta);
  const weight = getFoodWeightKg(item);
  const isPickedUp = item.status === 'Picked Up';
  const donorCoords = getDonorCoords(item);
  const ngoCoords = normalizeCoords(item.ngoLocation);

  const [updating, setUpdating] = useState(false);

  let mapsUrl = null;
  if (donorCoords) {
    mapsUrl = ngoCoords
      ? `https://www.google.com/maps/dir/?api=1&origin=${ngoCoords.lat},${ngoCoords.lng}&destination=${donorCoords.lat},${donorCoords.lng}&travelmode=driving`
      : `https://www.google.com/maps/dir/?api=1&destination=${donorCoords.lat},${donorCoords.lng}&travelmode=driving`;
  }

  const handleAction = async () => {
    setUpdating(true);
    try {
      if (isPickedUp) {
        await onMarkDelivered(item);
      } else {
        await onMarkPickedUp(item);
      }
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div
      style={{
        background: '#fff',
        borderRadius: 14,
        boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
        overflow: 'hidden',
        border: `2px solid ${isPickedUp ? '#bfdbfe' : '#a7f3d0'}`,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          height: 4,
          background: isPickedUp
            ? 'linear-gradient(90deg, #3b82f6, #60a5fa)'
            : 'linear-gradient(90deg, #10b981, #34d399)',
        }}
      />

      <div style={{ padding: '1rem 1.1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start', marginBottom: 6 }}>
          <span
            style={{
              fontSize: '0.65rem',
              fontWeight: 700,
              padding: '2px 10px',
              borderRadius: 20,
              background: isPickedUp ? '#eff6ff' : '#ecfdf5',
              color: isPickedUp ? '#1d4ed8' : '#065f46',
            }}
          >
            {isPickedUp ? '🚚 In Transit' : '📍 Pickup Accepted'}
          </span>

          <span
            style={{
              fontSize: '0.65rem',
              fontWeight: 700,
              padding: '2px 8px',
              borderRadius: 20,
              background: priority.bg,
              color: priority.color,
            }}
          >
            {priority.dot} {priority.label}
          </span>
        </div>

        <h3 style={{ fontSize: '0.95rem', fontWeight: 700, color: '#111827', marginBottom: 3 }}>
          {item.title || 'Food Donation'}
        </h3>

        <p style={{ fontSize: '0.78rem', color: '#6b7280', marginBottom: 10 }}>
          🏫 From {item.hostelName || item.donorName || 'Hostel'}
          {' · '}
          ⚖️ {formatWeight(weight)}
        </p>

        <div
          style={{
            background: priority.bg,
            border: `1px solid ${priority.color}33`,
            borderRadius: 9,
            padding: '9px 11px',
            marginBottom: 10,
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <div style={{ fontSize: '0.62rem', color: '#6b7280', fontWeight: 700, textTransform: 'uppercase' }}>
              ETA
            </div>
            <div style={{ fontSize: '1rem', fontWeight: 800, color: priority.color }}>
              ⏱ {formatEta(eta)}
            </div>
          </div>

          <div style={{ fontSize: '0.75rem', color: '#6b7280', textAlign: 'right' }}>
            {item.distance != null ? `${item.distance.toFixed(1)} km` : 'Distance unavailable'}
          </div>
        </div>

        {item.expiryTime && (
          <>
            <UrgencyBar pct={urgency.pct} type={urgency.type} />
            <div
              style={{
                fontSize: '0.75rem',
                fontWeight: 600,
                color:
                  urgency.type === 'danger'
                    ? '#ef4444'
                    : urgency.type === 'warning'
                    ? '#f59e0b'
                    : '#059669',
                marginBottom: 10,
              }}
            >
              ⏱ {urgency.expired ? 'Pickup window expired' : urgency.label}
            </div>
          </>
        )}

        <div
          style={{
            background: isPickedUp ? '#eff6ff' : '#ecfdf5',
            border: isPickedUp ? '1px solid #bfdbfe' : '1px solid #a7f3d0',
            borderRadius: 8,
            padding: '10px 12px',
            marginBottom: 10,
          }}
        >
          <div style={{ fontSize: '0.78rem', fontWeight: 700, color: isPickedUp ? '#1d4ed8' : '#065f46', marginBottom: 4 }}>
            {isPickedUp ? '🚚 Food has been picked up.' : '✅ Pickup has been accepted.'}
          </div>
          <div style={{ fontSize: '0.75rem', color: isPickedUp ? '#2563eb' : '#047857' }}>
            Donor location: <strong>{item.locationName || item.donorLocationName || 'Donor Location'}</strong>
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 6,
            marginBottom: 12,
          }}
        >
          <div style={{ background: '#f9fafb', borderRadius: 8, padding: '8px 6px', textAlign: 'center', border: '1px solid #f3f4f6' }}>
            <div>⚖️</div>
            <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#111827' }}>{formatWeight(weight)}</div>
            <div style={{ fontSize: '0.6rem', color: '#9ca3af' }}>Food Weight</div>
          </div>

          <div style={{ background: '#f9fafb', borderRadius: 8, padding: '8px 6px', textAlign: 'center', border: '1px solid #f3f4f6' }}>
            <div>🌍</div>
            <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#111827' }}>{(weight * 2.5).toFixed(1)} kg</div>
            <div style={{ fontSize: '0.6rem', color: '#9ca3af' }}>CO₂e estimate</div>
          </div>
        </div>

        {mapsUrl && (
          <a
            href={mapsUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              fontSize: '0.78rem',
              fontWeight: 600,
              color: '#3b82f6',
              padding: '7px 0',
              border: '1px solid #bfdbfe',
              borderRadius: 8,
              marginBottom: 10,
              textDecoration: 'none',
              background: '#eff6ff',
            }}
          >
            🧭 Open in Google Maps
          </a>
        )}

        <button
          onClick={handleAction}
          disabled={updating}
          style={{
            width: '100%',
            padding: '10px 0',
            borderRadius: 8,
            fontWeight: 700,
            fontSize: '0.9rem',
            background: updating
              ? '#9ca3af'
              : isPickedUp
              ? 'linear-gradient(135deg, #8b5cf6, #7c3aed)'
              : 'linear-gradient(135deg, #3b82f6, #2563eb)',
            color: '#fff',
            border: 'none',
            cursor: updating ? 'not-allowed' : 'pointer',
          }}
        >
          {updating
            ? '⏳ Updating…'
            : isPickedUp
            ? '✅ Mark as Delivered'
            : '📦 Mark as Picked Up'}
        </button>
      </div>
    </div>
  );
};

/* =========================================================
   HISTORY ROW
========================================================= */

const HistoryRow = ({ item, onOpen }) => {
  const weight = getFoodWeightKg(item);
  const status = item.status || item.orderStatus || 'Unknown';
  const label = getStatusLabel(status);
  const statusColor =
    status === 'Completed'
      ? '#059669'
      : status === 'Picked Up'
      ? '#7c3aed'
      : status === 'Accepted'
      ? '#2563eb'
      : '#6b7280';

  const deliveredDuration = getDurationMinutes(item.pickedUpAt, item.deliveredAt);

  return (
    <button
      onClick={() => onOpen(item)}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '13px 16px',
        borderRadius: 10,
        background: '#fff',
        border: '1px solid #e5e7eb',
        marginBottom: 8,
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
        textAlign: 'left',
        cursor: 'pointer',
      }}
    >
      <span style={{ fontSize: '1.5rem' }}>
        {status === 'Completed' ? '✅' : status === 'Picked Up' ? '🚚' : '📦'}
      </span>

      <div style={{ flex: 1, minWidth: 180 }}>
        <div style={{ fontSize: '0.88rem', fontWeight: 700, color: '#111827' }}>
          {item.title || 'Food Donation'}
        </div>
        <div style={{ fontSize: '0.74rem', color: '#6b7280', marginTop: 3 }}>
          From {item.hostelName || item.donorName || 'Hostel'} · Posted {fmtTime(item.createdAt)}
        </div>
      </div>

      <div style={{ textAlign: 'right', minWidth: 85 }}>
        <div style={{ fontSize: '0.86rem', fontWeight: 800, color: '#10b981' }}>
          {formatWeight(weight)}
        </div>
        {deliveredDuration != null && (
          <div style={{ fontSize: '0.68rem', color: '#6b7280' }}>
            Delivered in {formatDuration(deliveredDuration)}
          </div>
        )}
      </div>

      <div
        style={{
          padding: '4px 9px',
          borderRadius: 20,
          background: `${statusColor}15`,
          color: statusColor,
          fontSize: '0.68rem',
          fontWeight: 700,
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </div>

      <span style={{ color: '#9ca3af', fontSize: '1.1rem' }}>›</span>
    </button>
  );
};

/* =========================================================
   ORDER DETAILS MODAL
========================================================= */

const OrderDetailsModal = ({ item, onClose }) => {
  if (!item) return null;

  const weight = getFoodWeightKg(item);
  const donorCoords = getDonorCoords(item);
  const ngoCoords = normalizeCoords(item.ngoLocation);

  const distance =
    item.distanceKm != null
      ? Number(item.distanceKm)
      : item.distance != null
      ? Number(item.distance)
      : donorCoords && ngoCoords
      ? calcDistance(ngoCoords.lat, ngoCoords.lng, donorCoords.lat, donorCoords.lng)
      : null;

  const eta = getEtaMinutes({ ...item, distance: distance ?? item.distance });

  const pickupDuration = getDurationMinutes(item.acceptedAt || item.createdAt, item.pickedUpAt);
  const deliveryDuration = getDurationMinutes(item.pickedUpAt, item.deliveredAt);
  const totalDuration = getDurationMinutes(item.createdAt, item.deliveredAt);

  const mapsUrl = donorCoords
    ? ngoCoords
      ? `https://www.google.com/maps/dir/?api=1&origin=${ngoCoords.lat},${ngoCoords.lng}&destination=${donorCoords.lat},${donorCoords.lng}&travelmode=driving`
      : `https://www.google.com/maps/dir/?api=1&destination=${donorCoords.lat},${donorCoords.lng}&travelmode=driving`
    : null;

  const status = item.status || item.orderStatus || 'Unknown';

  const Detail = ({ icon, label, value }) => (
    <div
      style={{
        background: '#f9fafb',
        border: '1px solid #eef0f2',
        borderRadius: 10,
        padding: '10px 12px',
      }}
    >
      <div style={{ fontSize: '0.68rem', color: '#9ca3af', fontWeight: 700, textTransform: 'uppercase', marginBottom: 4 }}>
        {icon} {label}
      </div>
      <div style={{ fontSize: '0.88rem', color: '#111827', fontWeight: 700 }}>
        {value}
      </div>
    </div>
  );

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.55)',
        backdropFilter: 'blur(3px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        zIndex: 9999,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(720px, 100%)',
          maxHeight: '90vh',
          overflowY: 'auto',
          background: '#fff',
          borderRadius: 18,
          boxShadow: '0 25px 60px rgba(0,0,0,0.25)',
        }}
      >
        <div
          style={{
            padding: '18px 20px',
            background: 'linear-gradient(135deg, #064e3b, #047857)',
            color: '#fff',
            borderRadius: '18px 18px 0 0',
            display: 'flex',
            justifyContent: 'space-between',
            gap: 12,
            alignItems: 'flex-start',
          }}
        >
          <div>
            <div style={{ fontSize: '0.68rem', color: '#a7f3d0', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              Order Details
            </div>
            <h2 style={{ margin: '4px 0 3px', fontSize: '1.2rem' }}>
              {item.title || 'Food Donation'}
            </h2>
            <div style={{ fontSize: '0.78rem', color: '#d1fae5' }}>
              Order ID: {item.orderId || item.id}
            </div>
          </div>

          <button
            onClick={onClose}
            style={{
              width: 34,
              height: 34,
              borderRadius: '50%',
              border: '1px solid rgba(255,255,255,0.3)',
              background: 'rgba(255,255,255,0.1)',
              color: '#fff',
              fontSize: '1.15rem',
              cursor: 'pointer',
            }}
          >
            ×
          </button>
        </div>

        <div style={{ padding: 20 }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
              gap: 9,
              marginBottom: 16,
            }}
          >
            <Detail icon="⚖️" label="Food Weight" value={formatWeight(weight)} />
            <Detail icon="📍" label="Distance" value={distance != null ? `${distance.toFixed(1)} km` : 'Not available'} />
            <Detail icon="⏱️" label="Estimated ETA" value={formatEta(eta)} />
            <Detail icon="📌" label="Status" value={getStatusLabel(status)} />
          </div>

          <h3 style={{ fontSize: '0.9rem', color: '#111827', margin: '16px 0 9px' }}>
            📍 Route & People
          </h3>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 9,
            }}
          >
            <Detail icon="🏫" label="Donor / Hostel" value={item.hostelName || item.donorName || 'Not recorded'} />
            <Detail icon="📍" label="Donor Location" value={item.donorLocationName || item.locationName || 'Not recorded'} />
            <Detail icon="🤝" label="NGO" value={item.ngoName || 'Not recorded'} />
            <Detail icon="📍" label="NGO Location" value={item.ngoLocationName || 'Not recorded'} />
          </div>

          <h3 style={{ fontSize: '0.9rem', color: '#111827', margin: '18px 0 9px' }}>
            🕒 Order Timeline
          </h3>

          <div style={{ display: 'grid', gap: 8 }}>
            <Detail icon="📝" label="Posted" value={fmtDateTime(item.createdAt)} />
            <Detail icon="🤝" label="Accepted" value={fmtDateTime(item.acceptedAt)} />
            <Detail icon="📦" label="Picked Up" value={fmtDateTime(item.pickedUpAt)} />
            <Detail icon="✅" label="Delivered" value={fmtDateTime(item.deliveredAt || item.completedAt)} />
          </div>

          <h3 style={{ fontSize: '0.9rem', color: '#111827', margin: '18px 0 9px' }}>
            ⏱️ Delivery Timing
          </h3>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
              gap: 9,
            }}
          >
            <Detail icon="🚚" label="Accepted → Picked Up" value={formatDuration(pickupDuration)} />
            <Detail icon="🏁" label="Picked Up → Delivered" value={formatDuration(deliveryDuration)} />
            <Detail icon="⏰" label="Posted → Delivered" value={formatDuration(totalDuration)} />
          </div>

          <h3 style={{ fontSize: '0.9rem', color: '#111827', margin: '18px 0 9px' }}>
            📊 What Happened
          </h3>

          <div
            style={{
              background: '#f0fdf4',
              border: '1px solid #bbf7d0',
              borderRadius: 10,
              padding: '12px 14px',
              color: '#166534',
              fontSize: '0.82rem',
              lineHeight: 1.6,
            }}
          >
            <div>• Food posted by <strong>{item.hostelName || item.donorName || 'donor hostel'}</strong>.</div>
            <div>• Parcel weight recorded: <strong>{formatWeight(weight)}</strong>.</div>
            <div>• NGO accepted the pickup at <strong>{fmtTime(item.acceptedAt)}</strong>.</div>
            <div>• Food was picked up at <strong>{fmtTime(item.pickedUpAt)}</strong>.</div>
            <div>• Delivery was completed at <strong>{fmtTime(item.deliveredAt || item.completedAt)}</strong>.</div>
            <div>• Delivery duration after pickup: <strong>{formatDuration(deliveryDuration)}</strong>.</div>
          </div>

          {mapsUrl && (
            <a
              href={mapsUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                marginTop: 14,
                padding: 10,
                borderRadius: 9,
                background: '#eff6ff',
                color: '#2563eb',
                border: '1px solid #bfdbfe',
                textDecoration: 'none',
                fontWeight: 700,
                fontSize: '0.82rem',
              }}
            >
              🗺️ Open Route in Google Maps
            </a>
          )}
        </div>
      </div>
    </div>
  );
};

/* =========================================================
   MAIN NGO DASHBOARD
========================================================= */

const NgoDashboard = () => {
  const { currentUser, userData } = useAuth();

  const [listings, setListings] = useState({
    available: [],
    myAccepted: [],
  });
  const [history, setHistory] = useState([]);
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('available');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('eta');
  const [now, setNow] = useState(new Date());

  const knownIds = useRef([]);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(timer);
  }, []);

  /* =======================================================
     LIVE LISTINGS
  ======================================================= */

  useEffect(() => {
    if (!currentUser || !userData) {
      if (!currentUser) setLoading(false);
      return;
    }

    requestNotificationPermission();

    const q = query(
      collection(db, 'listings'),
      where('status', 'in', ['Available', 'Accepted', 'Picked Up'])
    );

    const unsubscribe = onSnapshot(
      q,
      (snap) => {
        const ngoCoords = getNgoCoords(userData);
        const all = [];

        snap.forEach((d) => {
          const data = d.data();
          const donorCoords = getDonorCoords(data);

          let distance = null;
          if (ngoCoords && donorCoords) {
            distance = calcDistance(
              ngoCoords.lat,
              ngoCoords.lng,
              donorCoords.lat,
              donorCoords.lng
            );
          }

          const item = {
            id: d.id,
            ...data,
            donorLocation: data.donorLocation || donorCoords || null,
            distance,
            etaMinutes: data.etaMinutes ?? getEtaMinutes({ ...data, distance }),
          };

          all.push(item);
        });

        if (knownIds.current.length > 0) {
          const newItems = all.filter(
            (item) =>
              !knownIds.current.includes(item.id) && item.status === 'Available'
          );

          if (newItems.length > 0) {
            const newFoodMessage =
              `${newItems[0].hostelName || 'A hostel'} posted: ${newItems[0].title || 'surplus food'}`;

            // Existing browser notification — KEEP
            sendNotification(
              'New Food Alert! 🥘',
              newFoodMessage
            );

            // ADD-ON: visible popup for the NGO
            window.alert(
              `🔔 New Food Available!\n\n${newFoodMessage}\n\nAvailable for NGO pickup.`
            );
          }
        }

        knownIds.current = all.map((item) => item.id);

        setListings({
          available: all.filter((item) => item.status === 'Available'),
          myAccepted: all.filter(
            (item) =>
              ['Accepted', 'Picked Up'].includes(item.status) &&
              item.ngoId === currentUser.uid
          ),
        });

        setLoading(false);
      },
      (error) => {
        console.error('NGO sync error:', error);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [currentUser, userData]);

  /* =======================================================
     ALL NGO ORDER HISTORY
  ======================================================= */

  useEffect(() => {
    if (!currentUser) return;

    const q = query(
      collection(db, 'listings'),
      where('ngoId', '==', currentUser.uid)
    );

    const unsubscribe = onSnapshot(
      q,
      (snap) => {
        const ngoCoords = getNgoCoords(userData);

        const rows = snap.docs.map((d) => {
          const data = d.data();
          const donorCoords = getDonorCoords(data);
          const savedNgoCoords = normalizeCoords(data.ngoLocation) || ngoCoords;

          let distance = data.distanceKm ?? null;

          if (distance == null && donorCoords && savedNgoCoords) {
            distance = calcDistance(
              savedNgoCoords.lat,
              savedNgoCoords.lng,
              donorCoords.lat,
              donorCoords.lng
            );
          }

          return {
            id: d.id,
            ...data,
            distanceKm: distance,
            etaMinutes: data.etaMinutes ?? getEtaMinutes({ ...data, distance }),
          };
        });

        rows.sort((a, b) => {
          const bTime = toMs(b.deliveredAt || b.completedAt || b.pickedUpAt || b.acceptedAt || b.createdAt);
          const aTime = toMs(a.deliveredAt || a.completedAt || a.pickedUpAt || a.acceptedAt || a.createdAt);
          return bTime - aTime;
        });

        setHistory(rows);
      },
      (error) => {
        console.error('History error:', error);
      }
    );

    return () => unsubscribe();
  }, [currentUser, userData]);

  /* =======================================================
     ACCEPT
  ======================================================= */

  const handleAccept = async (item) => {
    try {
      const ngoCoords = getNgoCoords(userData);
      const donorCoords = getDonorCoords(item);

      const distance =
        ngoCoords && donorCoords
          ? calcDistance(
              ngoCoords.lat,
              ngoCoords.lng,
              donorCoords.lat,
              donorCoords.lng
            )
          : item.distance ?? null;

      const eta = getEtaMinutes({ ...item, distance });

      await updateDoc(doc(db, 'listings', item.id), {
        status: 'Accepted',
        orderStatus: 'Accepted',
        ngoId: currentUser.uid,
        ngoName: userData?.name || 'Partner NGO',
        ngoLocation: ngoCoords,
        ngoLocationName:
          userData?.locationName ||
          userData?.address ||
          userData?.city ||
          'NGO Location',
        distanceKm: distance,
        etaMinutes: eta,
        etaText: formatEta(eta),
        acceptedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      console.error(error);
      alert('Failed to accept. Please retry.');
    }
  };

  /* =======================================================
     PICKED UP
  ======================================================= */

  const handlePickedUp = async (pickup) => {
    try {
      await updateDoc(doc(db, 'listings', pickup.id), {
        status: 'Picked Up',
        orderStatus: 'Picked Up',
        pickedUpAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      if (pickup.logId) {
        await updateDoc(doc(db, 'foodLogs', pickup.logId), {
          status: 'picked-up',
        });
      } else {
        const snap = await getDocs(
          query(
            collection(db, 'foodLogs'),
            where('hostelId', '==', pickup.hostelId),
            where('title', '==', pickup.title)
          )
        );

        await Promise.all(
          snap.docs.map((d) =>
            updateDoc(d.ref, { status: 'picked-up' })
          )
        );
      }
    } catch (error) {
      console.error(error);
      alert('Failed to update pickup status. Please retry.');
    }
  };

  /* =======================================================
     DELIVERED / COMPLETED
  ======================================================= */

  const handleDelivered = async (order) => {
    try {
      await updateDoc(doc(db, 'listings', order.id), {
        status: 'Completed',
        orderStatus: 'Completed',
        deliveredAt: serverTimestamp(),
        completedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      console.error(error);
      alert('Failed to mark delivery. Please retry.');
    }
  };

  /* =======================================================
     SEARCH + SORT
  ======================================================= */

  const filterSearch = (list) => {
    if (!search.trim()) return list;

    const q = search.toLowerCase().trim();

    return list.filter(
      (item) =>
        item.title?.toLowerCase().includes(q) ||
        item.hostelName?.toLowerCase().includes(q) ||
        item.locationName?.toLowerCase().includes(q) ||
        item.donorLocationName?.toLowerCase().includes(q)
    );
  };

  const sortFn = (a, b) => {
    if (sortBy === 'eta') {
      const aEta = getEtaMinutes(a);
      const bEta = getEtaMinutes(b);

      if (aEta == null && bEta == null) return 0;
      if (aEta == null) return 1;
      if (bEta == null) return -1;

      if (aEta !== bEta) return aEta - bEta;

      const aDistance = a.distance ?? a.distanceKm ?? Infinity;
      const bDistance = b.distance ?? b.distanceKm ?? Infinity;
      return aDistance - bDistance;
    }

    if (sortBy === 'distance') {
      const aDistance = a.distance ?? a.distanceKm;
      const bDistance = b.distance ?? b.distanceKm;
      if (aDistance == null && bDistance == null) return 0;
      if (aDistance == null) return 1;
      if (bDistance == null) return -1;
      return aDistance - bDistance;
    }

    if (sortBy === 'weight') {
      return getFoodWeightKg(b) - getFoodWeightKg(a);
    }

    return toMs(b.createdAt) - toMs(a.createdAt);
  };

  const visibleAvailable = useMemo(() => {
    return filterSearch(
      listings.available
        .filter((item) => !getUrgencyData(item.expiryTime, now).expired)
        .slice()
        .sort(sortFn)
    );
  }, [listings.available, search, sortBy, now]);

  const visibleAccepted = useMemo(() => {
    return listings.myAccepted.slice().sort(sortFn);
  }, [listings.myAccepted, sortBy]);

  /* =======================================================
     STATS
  ======================================================= */

  const totalKg = history.reduce((sum, item) => sum + getFoodWeightKg(item), 0);
  const totalCo2 = totalKg * 2.5;
  const availableKg = visibleAvailable.reduce((sum, item) => sum + getFoodWeightKg(item), 0);
  const deliveredCount = history.filter((item) => item.status === 'Completed').length;

  const tabs = [
    { id: 'available', label: 'Available', count: visibleAvailable.length, color: '#10b981' },
    { id: 'accepted', label: 'My Pickups', count: visibleAccepted.length, color: '#3b82f6' },
    { id: 'history', label: 'History', count: history.length, color: '#8b5cf6' },
  ];

  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 300, gap: 12 }}>
        <div style={{ width: 36, height: 36, border: '3px solid #e5e7eb', borderTopColor: '#10b981', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
        <p style={{ color: '#6b7280', fontSize: '0.9rem' }}>Loading NGO portal…</p>
      </div>
    );
  }

  return (
    <div className="dashboard-layout">
      <div className="container page-content">
        <div
          style={{
            background: 'linear-gradient(135deg, #064e3b 0%, #065f46 60%, #047857 100%)',
            borderRadius: 16,
            padding: '1.75rem 2rem',
            color: '#fff',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '1rem',
            marginBottom: '1.5rem',
            boxShadow: '0 10px 30px -5px rgba(6,95,70,0.35)',
          }}
        >
          <div>
            <div style={{ fontSize: '0.7rem', fontWeight: 700, color: '#a7f3d0', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>
              NGO Food Rescue Portal
            </div>
            <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: 0 }}>
              Welcome, {userData?.name || 'Partner NGO'} 👋
            </h1>
            <p style={{ fontSize: '0.85rem', color: '#d1fae5', marginTop: 4 }}>
              {visibleAvailable.length > 0
                ? `🔔 ${visibleAvailable.length} food ${visibleAvailable.length > 1 ? 'orders' : 'order'} available`
                : 'No active food listings at the moment.'}
            </p>
          </div>

          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '0.7rem', color: '#a7f3d0', marginBottom: 2 }}>Lifetime Impact</div>
            <div style={{ fontSize: '1.75rem', fontWeight: 800 }}>
              {totalKg.toFixed(2)} <span style={{ fontSize: '0.9rem', fontWeight: 500 }}>kg rescued</span>
            </div>
            <div style={{ fontSize: '0.8rem', color: '#d1fae5' }}>
              {totalCo2.toFixed(2)} kg CO₂e estimated avoided
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '0.9rem', marginBottom: '1.5rem' }}>
          <StatCard
            label="Available Orders"
            value={visibleAvailable.length}
            color="#10b981"
            icon="🟢"
            sub={`${availableKg.toFixed(2)} kg food available`}
          />
          <StatCard
            label="Active Pickups"
            value={visibleAccepted.length}
            color="#3b82f6"
            icon="🚚"
            sub="Accepted / in transit"
          />
          <StatCard
            label="Completed Deliveries"
            value={deliveredCount}
            color="#8b5cf6"
            icon="✅"
            sub={`${totalKg.toFixed(2)} kg across all orders`}
          />
        </div>

        <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', marginBottom: '1.25rem', overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.05)' }}>
          <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb' }}>
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  flex: 1,
                  padding: '13px 8px',
                  fontWeight: 700,
                  fontSize: '0.85rem',
                  color: activeTab === tab.id ? tab.color : '#6b7280',
                  border: 'none',
                  borderBottom: activeTab === tab.id ? `3px solid ${tab.color}` : '3px solid transparent',
                  background: 'none',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                }}
              >
                {tab.label}
                <span
                  style={{
                    fontSize: '0.65rem',
                    fontWeight: 800,
                    padding: '1px 7px',
                    borderRadius: 20,
                    background: activeTab === tab.id ? tab.color : '#f3f4f6',
                    color: activeTab === tab.id ? '#fff' : '#6b7280',
                  }}
                >
                  {tab.count}
                </span>
              </button>
            ))}
          </div>

          {activeTab === 'available' && (
            <div style={{ display: 'flex', gap: 10, padding: '12px 14px', flexWrap: 'wrap' }}>
              <input
                type="text"
                placeholder="🔍 Search food, hostel, or location…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{ flex: 1, minWidth: 200, padding: '8px 12px', fontSize: '0.85rem', border: '1px solid #e5e7eb', borderRadius: 8, background: '#f9fafb' }}
              />
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                style={{ padding: '8px 12px', fontSize: '0.85rem', border: '1px solid #e5e7eb', borderRadius: 8, background: '#f9fafb', color: '#374151', fontWeight: 600, minWidth: 170 }}
              >
                <option value="eta">Sort: ETA (fastest)</option>
                <option value="distance">Sort: Distance</option>
                <option value="weight">Sort: Food Weight</option>
                <option value="time">Sort: Newest</option>
              </select>
            </div>
          )}
        </div>

        {activeTab === 'available' && (
          visibleAvailable.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '4rem 2rem', background: '#f9fafb', borderRadius: 14, border: '2px dashed #e5e7eb', color: '#6b7280' }}>
              <div style={{ fontSize: '2.5rem', marginBottom: 12 }}>🍽️</div>
              <h3 style={{ fontSize: '1.1rem', color: '#374151', fontWeight: 700, marginBottom: 6 }}>
                {search ? 'No listings match your search' : 'No Food Available Right Now'}
              </h3>
              <p style={{ fontSize: '0.85rem' }}>
                {search ? 'Try a different search term.' : 'Partner hostels will post surplus food here.'}
              </p>
              {search && (
                <button onClick={() => setSearch('')} style={{ marginTop: 12, padding: '8px 20px', background: '#10b981', color: '#fff', borderRadius: 8, fontWeight: 600, border: 'none', cursor: 'pointer' }}>
                  Clear Search
                </button>
              )}
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '1rem' }}>
              {visibleAvailable.map((item) => (
                <AvailableCard key={item.id} item={item} onAccept={handleAccept} now={now} />
              ))}
            </div>
          )
        )}

        {activeTab === 'accepted' && (
          visibleAccepted.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '4rem 2rem', background: '#f9fafb', borderRadius: 14, border: '2px dashed #e5e7eb', color: '#6b7280' }}>
              <div style={{ fontSize: '2.5rem', marginBottom: 12 }}>🚚</div>
              <h3 style={{ fontSize: '1.1rem', color: '#374151', fontWeight: 700, marginBottom: 6 }}>No Active Pickups</h3>
              <p style={{ fontSize: '0.85rem' }}>Accepted and in-transit orders will appear here.</p>
              <button onClick={() => setActiveTab('available')} style={{ marginTop: 12, padding: '8px 20px', background: '#10b981', color: '#fff', borderRadius: 8, fontWeight: 600, border: 'none', cursor: 'pointer' }}>
                Browse Available →
              </button>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '1rem' }}>
              {visibleAccepted.map((item) => (
                <AcceptedCard
                  key={item.id}
                  item={item}
                  onMarkPickedUp={handlePickedUp}
                  onMarkDelivered={handleDelivered}
                  now={now}
                />
              ))}
            </div>
          )
        )}

        {activeTab === 'history' && (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.75rem', marginBottom: '1.25rem' }}>
              {[
                { label: 'All Orders', value: history.length, icon: '📦', color: '#8b5cf6' },
                { label: 'Food Weight', value: `${totalKg.toFixed(2)} kg`, icon: '⚖️', color: '#10b981' },
                { label: 'Delivered', value: deliveredCount, icon: '✅', color: '#2563eb' },
                { label: 'CO₂e Estimate', value: `${totalCo2.toFixed(2)} kg`, icon: '🌍', color: '#06b6d4' },
              ].map(({ label, value, icon, color }) => (
                <div key={label} style={{ background: '#fff', borderRadius: 10, padding: '12px 14px', border: '1px solid #e5e7eb', borderTop: `3px solid ${color}`, textAlign: 'center' }}>
                  <div style={{ fontSize: '1.3rem' }}>{icon}</div>
                  <div style={{ fontSize: '1.15rem', fontWeight: 800, color, marginTop: 4 }}>{value}</div>
                  <div style={{ fontSize: '0.7rem', color: '#9ca3af' }}>{label}</div>
                </div>
              ))}
            </div>

            <div style={{ marginBottom: 12, fontSize: '0.78rem', color: '#6b7280', fontWeight: 600 }}>
              Click any order to view complete details, timeline and delivery time.
            </div>

            {history.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '4rem 2rem', background: '#f9fafb', borderRadius: 14, border: '2px dashed #e5e7eb', color: '#6b7280' }}>
                <div style={{ fontSize: '2.5rem', marginBottom: 12 }}>📜</div>
                <h3 style={{ fontSize: '1.1rem', color: '#374151', fontWeight: 700, marginBottom: 6 }}>No Orders Yet</h3>
                <p style={{ fontSize: '0.85rem' }}>Your NGO order history will appear here.</p>
              </div>
            ) : (
              history.map((item) => (
                <HistoryRow key={item.id} item={item} onOpen={setSelectedOrder} />
              ))
            )}
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }

        @media (max-width: 640px) {
          .page-content {
            padding-left: 12px !important;
            padding-right: 12px !important;
          }
        }
      `}</style>

      <OrderDetailsModal
        item={selectedOrder}
        onClose={() => setSelectedOrder(null)}
      />
    </div>
  );
};

export default NgoDashboard;
