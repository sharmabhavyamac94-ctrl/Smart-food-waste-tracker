import React from 'react';
import { Link } from 'react-router-dom';
import { useHostelData } from '../context/HostelDataContext';
import { useAuth } from '../context/AuthContext';

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer
} from 'recharts';

import {
  doc,
  updateDoc,
  collection,
  query,
  where,
  getDocs
} from 'firebase/firestore';

import { db } from '../config/firebase';

const HostelDashboard = () => {
  const { userData } = useAuth();

  const {
    logs,
    kpis,
    actions,
    rescueFunnel,
    loading,
    listings
  } = useHostelData();

  const acceptedPickups =
    listings?.filter(l => l.status === 'Accepted') || [];

  const activeActions =
    actions?.filter(a => a.status === 'active') || [];

  const suggestedActions =
    actions?.filter(a => a.status === 'suggested') || [];

  const handlePickedUp = async pickup => {
    try {
      if (!db) return;

      const listingRef = doc(db, 'listings', pickup.id);

      await updateDoc(listingRef, {
        status: 'Picked Up',
        pickedUpAt: new Date().toISOString()
      });

      if (pickup.logId) {
        const logRef = doc(db, 'foodLogs', pickup.logId);

        await updateDoc(logRef, {
          status: 'picked-up'
        });
      } else {
        const qLogs = query(
          collection(db, 'foodLogs'),
          where('hostelId', '==', pickup.hostelId),
          where('title', '==', pickup.title)
        );

        const snap = await getDocs(qLogs);

        snap.forEach(async logDoc => {
          await updateDoc(logDoc.ref, {
            status: 'picked-up'
          });
        });
      }
    } catch (error) {
      console.error('Error updating status:', error);
      alert('Failed to update status. Please try again.');
    }
  };

  if (loading) {
    return (
      <div className="subpage-loading">
        <div className="loading-spinner"></div>
        <p>Loading dashboard...</p>
      </div>
    );
  }

  return (
    <div
      className="subpage-container"
      style={{
        width: '100%',
        maxWidth: 'none',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 'clamp(1rem, 2vw, 1.5rem)',
        overflowX: 'hidden'
      }}
    >
      {/* =====================================================
          HEADER
      ====================================================== */}
      <header
        style={{
          width: '100%',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: '1rem',
          flexWrap: 'wrap',
          boxSizing: 'border-box'
        }}
      >
        <div style={{ minWidth: 0, flex: '1 1 280px' }}>
          <h1
            className="subpage-title"
            style={{
              marginBottom: '0.35rem',
              wordBreak: 'break-word'
            }}
          >
            Operations Overview
          </h1>

          <p
            className="subpage-subtitle"
            style={{
              margin: 0,
              wordBreak: 'break-word'
            }}
          >
            {userData?.name || 'Hostel Mess'} Kitchen Intelligence
          </p>
        </div>

        <div
          style={{
            display: 'flex',
            gap: '0.6rem',
            flexWrap: 'wrap',
            width: '100%',
            maxWidth: 'fit-content'
          }}
        >
          <Link
            to="/hostel-dashboard"
            className="btn btn-secondary"
            style={{
              padding: '9px 14px',
              fontSize: '0.84rem',
              whiteSpace: 'nowrap',
              flex: '0 1 auto'
            }}
          >
            📊 Deep Analytics
          </Link>

          <Link
            to="/hostel-dashboard/ai-analytics"
            className="btn btn-primary"
            style={{
              padding: '9px 14px',
              fontSize: '0.84rem',
              whiteSpace: 'nowrap',
              flex: '0 1 auto'
            }}
          >
            ⚡ AI Actions ({suggestedActions.length})
          </Link>
        </div>
      </header>

      {/* =====================================================
          PLATESCAN AI BANNER
      ====================================================== */}
      <section
        className="card"
        style={{
          width: '100%',
          boxSizing: 'border-box',
          padding: 'clamp(1rem, 2vw, 1.35rem)',
          background:
            'linear-gradient(135deg, #effaf1, #f8fbf5)',
          border: '1px solid #cfe8d2',
          overflow: 'hidden'
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '1rem',
            flexWrap: 'wrap'
          }}
        >
          <div
            style={{
              flex: '1 1 300px',
              minWidth: 0
            }}
          >
            <div
              style={{
                fontSize: '1.05rem',
                fontWeight: 800,
                color: '#173b25'
              }}
            >
              🍽️ PlateScan AI
            </div>

            <div
              style={{
                marginTop: '5px',
                fontSize: '0.85rem',
                lineHeight: 1.5,
                color: '#5f6f63',
                maxWidth: '720px'
              }}
            >
              Automatically scan plates, identify leftover food,
              and track waste round-by-round.
            </div>
          </div>

          <Link
            to="/hostel-dashboard/platescan"
            className="btn btn-primary"
            style={{
              padding: '9px 15px',
              whiteSpace: 'nowrap',
              flexShrink: 0
            }}
          >
            Open PlateScan →
          </Link>
        </div>
      </section>

      {/* =====================================================
          AI ACTION BANNER
      ====================================================== */}
      {(suggestedActions.length > 0 ||
        activeActions.length > 0) && (
        <section
          style={{
            width: '100%',
            boxSizing: 'border-box',
            backgroundColor: '#eff6ff',
            border: '1px solid #bfdbfe',
            borderRadius: 'var(--radius-md, 8px)',
            padding: '12px 16px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '12px',
            overflow: 'hidden'
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: '10px',
              minWidth: 0,
              flex: '1 1 280px'
            }}
          >
            <span
              style={{
                fontSize: '1.25rem',
                flexShrink: 0
              }}
            >
              ⚡
            </span>

            <div style={{ minWidth: 0 }}>
              <strong
                style={{
                  display: 'block',
                  color: '#1e40af',
                  fontSize: '0.9rem',
                  lineHeight: 1.4
                }}
              >
                {activeActions.length > 0
                  ? `${activeActions.length} Active Reduction Goals in Progress`
                  : `${suggestedActions.length} New AI Action Recommendations Ready`}
              </strong>

              <div
                style={{
                  marginTop: '3px',
                  fontSize: '0.8rem',
                  lineHeight: 1.45,
                  color: '#3b82f6',
                  wordBreak: 'break-word'
                }}
              >
                {activeActions.length > 0
                  ? activeActions[0].title
                  : 'Review opportunities to trim surplus batches & optimize donation timing.'}
              </div>
            </div>
          </div>

          <Link
            to="/hostel-dashboard/ai-analytics"
            className="btn btn-primary"
            style={{
              padding: '7px 12px',
              fontSize: '0.8rem',
              whiteSpace: 'nowrap',
              flexShrink: 0
            }}
          >
            Open Actions Board →
          </Link>
        </section>
      )}

      {/* =====================================================
          KPI CARDS
      ====================================================== */}
      <section
        className="kpi-grid"
        style={{
          width: '100%',
          boxSizing: 'border-box'
        }}
      >
        <div className="kpi-card kpi-prepared">
          <span className="kpi-label">
            TOTAL PREPARED
          </span>

          <p className="kpi-value">
            {kpis.totalPrepared}
          </p>

          <div className="kpi-icon">
            🍽️
          </div>
        </div>

        <div className="kpi-card kpi-consumed">
          <span className="kpi-label">
            TOTAL CONSUMED
          </span>

          <p className="kpi-value">
            {kpis.totalConsumed}
          </p>

          <div className="kpi-icon">
            ✅
          </div>
        </div>

        <div className="kpi-card kpi-waste">
          <span className="kpi-label">
            TOTAL SURPLUS
          </span>

          <p className="kpi-value">
            {kpis.totalSurplus}
          </p>

          <div className="kpi-icon">
            🍲
          </div>
        </div>

        <div
          className={`kpi-card kpi-pct ${
            kpis.wasteRate > 15 ? 'kpi-danger' : ''
          }`}
        >
          <span className="kpi-label">
            NET WASTE RATE
          </span>

          <p className="kpi-value">
            {kpis.wasteRate}%
          </p>

          <div className="kpi-icon">
            📉
          </div>
        </div>
      </section>

      {/* =====================================================
          ACTIVE NGO PICKUPS
      ====================================================== */}
      {acceptedPickups.length > 0 && (
        <section
          style={{
            width: '100%',
            boxSizing: 'border-box',
            backgroundColor: '#ecfdf5',
            border: '1px solid #34d399',
            borderRadius: 'var(--radius-md, 10px)',
            padding: 'clamp(1rem, 2vw, 1.25rem)',
            overflow: 'hidden'
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '0.75rem',
              flexWrap: 'wrap',
              marginBottom: '1rem'
            }}
          >
            <h2
              style={{
                margin: 0,
                fontSize: 'clamp(1rem, 2vw, 1.1rem)',
                color: '#065f46',
                fontWeight: '700'
              }}
            >
              🚚 Active Pickups (NGO Partner En Route)
            </h2>

            <span
              style={{
                fontSize: '0.75rem',
                fontWeight: '600',
                padding: '4px 9px',
                borderRadius: '5px',
                backgroundColor: '#a7f3d0',
                color: '#065f46',
                whiteSpace: 'nowrap'
              }}
            >
              {acceptedPickups.length} In Transit
            </span>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns:
                'repeat(auto-fit, minmax(min(100%, 280px), 1fr))',
              gap: '1rem'
            }}
          >
            {acceptedPickups.map(pickup => (
              <div
                key={pickup.id}
                style={{
                  background: '#ffffff',
                  padding: '1rem',
                  borderRadius: 'var(--radius-md, 10px)',
                  border: '1px solid var(--border)',
                  minWidth: 0,
                  boxSizing: 'border-box'
                }}
              >
                <h3
                  style={{
                    fontSize: '1rem',
                    fontWeight: '600',
                    margin: '0 0 0.3rem',
                    wordBreak: 'break-word'
                  }}
                >
                  {pickup.title}
                </h3>

                <p
                  style={{
                    fontSize: '0.8rem',
                    lineHeight: 1.5,
                    color: 'var(--text-muted)',
                    margin: '0 0 0.75rem',
                    wordBreak: 'break-word'
                  }}
                >
                  Accepted by:{' '}
                  <strong
                    style={{
                      color: 'var(--text-main)'
                    }}
                  >
                    {pickup.ngoName || 'NGO Partner'}
                  </strong>{' '}
                  ({pickup.quantity} portions)
                </p>

                <button
                  onClick={() => handlePickedUp(pickup)}
                  className="btn btn-primary"
                  style={{
                    width: '100%',
                    minHeight: '40px',
                    padding: '8px 10px',
                    fontSize: '0.84rem'
                  }}
                >
                  Confirm Handover & Picked Up ✓
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* =====================================================
          FOOD RESCUE FUNNEL
      ====================================================== */}
      <section
        className="card analytics-chart-card"
        style={{
          width: '100%',
          maxWidth: 'none',
          boxSizing: 'border-box',
          padding: 'clamp(1rem, 2vw, 1.5rem)',
          overflow: 'hidden'
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '0.75rem',
            flexWrap: 'wrap',
            marginBottom: '1rem'
          }}
        >
          <h2
            className="card-section-title"
            style={{
              margin: 0,
              fontSize: 'clamp(1rem, 2vw, 1.15rem)',
              fontWeight: '600'
            }}
          >
            🎯 Food Rescue Funnel
          </h2>

          <Link
            to="/hostel-dashboard"
            style={{
              fontSize: '0.8rem',
              color: 'var(--primary)',
              fontWeight: '600',
              whiteSpace: 'nowrap'
            }}
          >
            Detailed View →
          </Link>
        </div>

        <div
          style={{
            width: '100%',
            height: 'clamp(250px, 32vw, 300px)',
            minWidth: 0
          }}
        >
          <ResponsiveContainer
            width="100%"
            height="100%"
          >
            <BarChart
              data={rescueFunnel}
              layout="vertical"
              margin={{
                top: 5,
                right: 15,
                left: 15,
                bottom: 5
              }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                horizontal={false}
                stroke="var(--border)"
              />

              <XAxis
                type="number"
                stroke="var(--text-muted)"
                fontSize={11}
              />

              <YAxis
                dataKey="stage"
                type="category"
                stroke="var(--text-muted)"
                fontSize={11}
                width={75}
              />

              <Tooltip
                formatter={(val, name, item) => [
                  `${val} portions`,
                  item.payload.description
                ]}
                contentStyle={{
                  backgroundColor: 'var(--surface)',
                  borderColor: 'var(--border)',
                  borderRadius: '8px',
                  fontSize: '0.8rem'
                }}
              />

              <Bar
                dataKey="value"
                fill="#3b82f6"
                radius={[0, 4, 4, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* =====================================================
          RECENT MEAL VOLUME
      ====================================================== */}
      <section
        className="card analytics-volume-card"
        style={{
          width: '100%',
          maxWidth: 'none',
          boxSizing: 'border-box',
          padding: 'clamp(1rem, 2vw, 1.5rem)',
          overflow: 'hidden'
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '0.75rem',
            flexWrap: 'wrap',
            marginBottom: '1rem'
          }}
        >
          <h2
            className="card-section-title"
            style={{
              margin: 0,
              fontSize: 'clamp(1rem, 2vw, 1.15rem)',
              fontWeight: '600'
            }}
          >
            📊 Recent Meal Volume Comparison
          </h2>

          <span
            style={{
              fontSize: '0.8rem',
              color: 'var(--text-muted)',
              whiteSpace: 'nowrap'
            }}
          >
            Prepared vs Consumed
          </span>
        </div>

        <div
          className="chart-container-lg"
          style={{
            width: '100%',
            height: 'clamp(240px, 30vw, 280px)',
            minWidth: 0
          }}
        >
          <ResponsiveContainer
            width="100%"
            height="100%"
          >
            <BarChart
              data={logs}
              margin={{
                top: 5,
                right: 10,
                left: 0,
                bottom: 5
              }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                vertical={false}
                stroke="var(--border)"
              />

              <XAxis
                dataKey="title"
                tick={{ fontSize: 11 }}
                interval="preserveStartEnd"
              />

              <YAxis
                stroke="var(--text-muted)"
                fontSize={11}
              />

              <Tooltip
                contentStyle={{
                  backgroundColor: '#1f2937',
                  border: 'none',
                  borderRadius: '8px',
                  color: '#f9fafb',
                  fontSize: '0.85rem'
                }}
              />

              <Legend
                wrapperStyle={{
                  fontSize: '0.8rem'
                }}
              />

              <Bar
                dataKey="prepared"
                fill="#3b82f6"
                name="Prepared"
                radius={[4, 4, 0, 0]}
              />

              <Bar
                dataKey="consumed"
                fill="#10b981"
                name="Consumed"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>
    </div>
  );
};

export default HostelDashboard;