import { useEffect, useMemo, useState } from 'react';
import {
  addDoc,
  collection,
  onSnapshot,
  query,
  where,
  serverTimestamp,
  doc,
  updateDoc
} from 'firebase/firestore';
import { db } from '../config/firebase';
import { useAuth } from '../context/AuthContext';
import toast from 'react-hot-toast';

const MEALS = ['Breakfast', 'Lunch', 'Evening Snacks', 'Dinner'];

const CATEGORIES = [
  'Rice / Grains',
  'Dal / Pulses',
  'Sabzi / Vegetables',
  'Roti / Bread',
  'Snacks',
  'Dairy / Curd',
  'Other'
];

const EMPTY = () => ({
  category: 'Rice / Grains',
  name: '',
  preparedKg: null,
  plateWasteKg: null,
  remainingKg: null,
  remainingCapturedAt: null,
  expiryHours: 2,
  expiryTime: null
});

async function readLoadCell() {
  const response = await fetch(
    '/api/hardware/weight/latest',
    {
      cache: 'no-store'
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.weightKg == null) {
    throw new Error(
      data.error || 'Weight Machine is not connected.'
    );
  }

  const weight = Number(data.weightKg);

  if (!Number.isFinite(weight)) {
    throw new Error('Invalid weight received from Load Cell.');
  }

  return weight;
}

const kg = value =>
  value == null
    ? '—'
    : `${Number(value).toFixed(3)} kg`;

export default function MealEntry() {
  const { currentUser } = useAuth();

  const [date, setDate] = useState(
    new Date().toISOString().slice(0, 10)
  );

  const [mealType, setMealType] = useState('Lunch');
  const [items, setItems] = useState([EMPTY()]);
  const [preparedLocked, setPreparedLocked] = useState(false);
  const [remainingSubmitted, setRemainingSubmitted] = useState(false);
  const [capturing, setCapturing] = useState(null);
  const [totalPlateWasteKg, setTotalPlateWasteKg] = useState(null);

  const [liveWeightKg, setLiveWeightKg] = useState(null);
  const [liveWeightStatus, setLiveWeightStatus] = useState('connecting');

  const [saved, setSaved] = useState([]);
  const [tab, setTab] = useState('entry');
  const [selectedHistory, setSelectedHistory] = useState(null);
  const [savedMealEntryId, setSavedMealEntryId] = useState(null);
  const [expirySaved, setExpirySaved] = useState(false);
  const [finalLocked, setFinalLocked] = useState(false);

  // ==========================================
  // FIREBASE SAVED MEALS
  // ==========================================

  useEffect(() => {
    if (!db || !currentUser) return undefined;

    const q = query(
      collection(db, 'mealEntries'),
      where('hostelId', '==', currentUser.uid),
      where('date', '==', date)
    );

    return onSnapshot(q, snap =>
      setSaved(
        snap.docs.map(d => ({
          id: d.id,
          ...d.data()
        }))
      )
    );
  }, [currentUser, date]);

  // ==========================================
  // LIVE LOAD CELL WEIGHT
  // ==========================================
  // Automatically reads the latest weight every 500 ms.
  // This is independent of the manual "Read" buttons.

  useEffect(() => {
    let stopped = false;
    let timer = null;

    const fetchLiveWeight = async () => {
      try {
        setLiveWeightStatus('connecting');

        const response = await fetch(
          '/api/hardware/weight/latest',
          {
            cache: 'no-store'
          }
        );

        const data = await response
          .json()
          .catch(() => ({}));

        if (
          stopped
        ) {
          return;
        }

        if (
          !response.ok ||
          data.weightKg == null
        ) {
          setLiveWeightStatus('waiting');

          timer = setTimeout(
            fetchLiveWeight,
            500
          );

          return;
        }

        const weight = Number(
          data.weightKg
        );

        if (!Number.isFinite(weight)) {
          setLiveWeightStatus('waiting');

          timer = setTimeout(
            fetchLiveWeight,
            500
          );

          return;
        }

        setLiveWeightKg(weight);
        setLiveWeightStatus('live');

      } catch (error) {
        if (!stopped) {
          setLiveWeightStatus('waiting');

          timer = setTimeout(
            fetchLiveWeight,
            500
          );
        }

        return;
      }

      if (!stopped) {
        timer = setTimeout(
          fetchLiveWeight,
          500
        );
      }
    };

    fetchLiveWeight();

    return () => {
      stopped = true;

      if (timer) {
        clearTimeout(timer);
      }
    };
  }, []);

  // ==========================================
  // UPDATE FOOD ITEM
  // ==========================================

  const updateItem = (index, patch) => {
    setItems(prev =>
      prev.map((item, i) =>
        i === index
          ? { ...item, ...patch }
          : item
      )
    );
  };

  // ==========================================
  // MANUAL READ LOAD CELL
  // ==========================================

  const capture = async (index, field) => {
    setCapturing(`${index}:${field}`);

    try {
      const value = await readLoadCell();

      const patch = {
        [field]: Number(
          value.toFixed(3)
        )
      };

      if (field === 'remainingKg') {
        patch.remainingCapturedAt =
          new Date().toISOString();

        patch.expiryTime = null;
      }

      updateItem(index, patch);

      if (field === 'remainingKg') {
        setExpirySaved(false);
        setFinalLocked(false);
      }

      toast.success(
        `${
          field === 'preparedKg'
            ? 'Prepared'
            : 'Remaining'
        } weight captured.`
      );

    } catch (e) {
      toast.error(
        e.message ||
          'Load cell unavailable'
      );
    } finally {
      setCapturing(null);
    }
  };

  // ==========================================
  // TOTAL PLATE WASTE
  // ==========================================

  const captureTotalPlateWaste = async () => {
    setCapturing('total-waste');

    try {
      const value = await readLoadCell();

      setTotalPlateWasteKg(
        Number(
          value.toFixed(3)
        )
      );

      toast.success(
        'Total plate waste captured.'
      );

    } catch (e) {
      toast.error(
        e.message ||
          'Load cell unavailable'
      );
    } finally {
      setCapturing(null);
    }
  };

  // ==========================================
  // ADD NEXT FOOD ITEM
  // ==========================================

  const addNext = () => {
    if (preparedLocked) {
      toast.error(
        'Food is already locked. Use the Add Next Item button in Food Remaining to add another item.'
      );

      return;
    }

    setItems(prev => [
      ...prev,
      EMPTY()
    ]);
  };

  const addNextFromRemaining = () => {
    if (finalLocked) return;

    setItems(prev => [
      ...prev,
      EMPTY()
    ]);

    setPreparedLocked(false);
    setRemainingSubmitted(false);
    setExpirySaved(false);
    setFinalLocked(false);

    toast(
      'New item added. Capture its prepared weight, then lock prepared food again.'
    );
  };

  // ==========================================
  // SUBMIT PREPARED FOOD
  // ==========================================

  const submitPrepared = () => {
    if (
      items.some(
        x =>
          !x.name.trim() ||
          x.preparedKg == null
      )
    ) {
      toast.error(
        'Complete food name and prepared weight for every item first.'
      );

      return;
    }

    setPreparedLocked(true);

    toast.success(
      'Prepared food saved and locked.'
    );
  };

  // ==========================================
  // SUBMIT REMAINING FOOD
  // ==========================================

  const submitRemaining = async () => {
  if (
    items.some(
      x => x.remainingKg == null
    )
  ) {
    toast.error(
      'Capture remaining weight for every item first.'
    );
    return;
  }

  if (!db || !currentUser) {
    toast.error(
      'Firebase is not configured.'
    );
    return;
  }

  const payload = {
    hostelId: currentUser.uid,
    date,
    mealType,
    status: 'completed',

    totalPlateWasteKg:
      Number(totalPlateWasteKg || 0),

    items: items.map((x, i) => ({
      itemNumber: i + 1,

      category: x.category,

      name: x.name.trim(),

      preparedKg:
        Number(x.preparedKg),

      plateWasteKg:
        Number(x.plateWasteKg || 0),

      remainingKg:
        Number(x.remainingKg),

      consumedKg: Math.max(
        0,
        Number(x.preparedKg) -
          Number(x.remainingKg) -
          Number(x.plateWasteKg || 0)
      ),

      remainingCapturedAt:
        x.remainingCapturedAt ||
        new Date().toISOString(),

      expiryHours:
        Number(x.expiryHours || 2),

      expiryTime:
        x.expiryTime || null
    })),

    createdAt:
      serverTimestamp(),

    expirySaved: false,

    finalSubmitted: false
  };

  try {
    // Keep the original Meal Entry save
    const savedMeal =
      await addDoc(
        collection(db, 'mealEntries'),
        payload
      );

    setSavedMealEntryId(
      savedMeal.id
    );

    // Create Food Logs for NGO workflow
    for (const item of payload.items) {
      await addDoc(
        collection(db, 'foodLogs'),
        {
          hostelId: currentUser.uid,

          title:
            `${mealType} - ${item.name}`,

          foodItem: item.name,

          mealType,

          category: item.category,

          prepared: item.preparedKg,
          preparedKg: item.preparedKg,

          consumed: item.consumedKg,
          consumedKg: item.consumedKg,

          surplus: item.remainingKg,
          remainingKg: item.remainingKg,

          plateWasteKg:
            item.plateWasteKg,

          totalPlateWasteKg:
            Number(totalPlateWasteKg || 0),

          unit: 'kg',

          status:
            item.remainingKg > 0
              ? 'pending'
              : 'zero-waste',

          source: 'meal-entry',
          sourceLabel: 'Meal Entry',

          mealDate: date,

          itemNumber:
            item.itemNumber,

          remainingCapturedAt:
            item.remainingCapturedAt,

          freshnessMinutes:
            Number(item.expiryHours || 2) * 60,

          validityMinutes:
            Number(item.expiryHours || 2) * 60,

          expiryTime:
            item.expiryTime || null,

          perishability: 'fresh',

          mealEntryId:
            savedMeal.id,

          createdAt:
            serverTimestamp()
        }
      );
    }

    setRemainingSubmitted(true);

    setExpirySaved(false);

    setFinalLocked(false);

    toast.success(
      `${mealType} meal saved.`
    );

  } catch (e) {
    console.error(
      'Meal save error:',
      e
    );

    toast.error(
      e.message ||
        'Could not save meal.'
    );
  }
};

  // ==========================================
  // FOOD FRESHNESS / EXPIRY
  // ==========================================

  const saveFoodExpiry = async () => {
    if (!savedMealEntryId) {
      toast.error(
        'Please submit remaining food first.'
      );

      return;
    }

    if (
      items.some(
        x =>
          !x.name.trim() ||
          !x.remainingCapturedAt ||
          !Number.isFinite(
            Number(x.expiryHours)
          ) ||
          Number(x.expiryHours) <= 0
      )
    ) {
      toast.error(
        'Enter food name and valid expiry hours for every item first.'
      );

      return;
    }

    const updatedItems =
      items.map((x, i) => {
        const hours =
          Number(
            x.expiryHours
          );

        const remainingCapturedAt =
          x.remainingCapturedAt ||
          new Date().toISOString();

        const expiryTime =
          new Date(
            new Date(
              remainingCapturedAt
            ).getTime() +
              hours *
                60 *
                60 *
                1000
          ).toISOString();

        return {
          ...x,

          itemNumber: i + 1,

          expiryHours: hours,

          expiryTime
        };
      });

    try {
      await updateDoc(
        doc(
          db,
          'mealEntries',
          savedMealEntryId
        ),
        {
          items: updatedItems,

          expirySaved: true,

          expirySavedAt:
            serverTimestamp()
        }
      );

      setItems(
        updatedItems
      );

      setExpirySaved(true);

      toast.success(
        'Food expiry saved successfully.'
      );

    } catch (e) {
      toast.error(
        e.message ||
          'Could not save food expiry.'
      );
    }
  };

  // ==========================================
  // FINAL SUBMIT & LOCK MEAL
  // ==========================================

  const submitAndLockMeal =
    async () => {
      if (!savedMealEntryId) {
        toast.error(
          'Please submit remaining food first.'
        );

        return;
      }

      if (!expirySaved) {
        toast.error(
          'Please save Food Freshness / Expiry first.'
        );

        return;
      }

      try {
        await updateDoc(
          doc(
            db,
            'mealEntries',
            savedMealEntryId
          ),
          {
            status: 'locked',

            finalSubmitted: true,

            finalSubmittedAt:
              serverTimestamp(),

            totalPlateWasteKg:
              Number(
                totalPlateWasteKg || 0
              )
          }
        );

        setFinalLocked(true);

        toast.success(
          'Meal submitted & locked successfully.'
        );

      } catch (e) {
        toast.error(
          e.message ||
            'Could not lock the meal.'
        );
      }
    };

  // ==========================================
  // TOTALS
  // ==========================================

  const totals = useMemo(() => {
    const prepared =
      items.reduce(
        (n, x) =>
          n +
          Number(
            x.preparedKg || 0
          ),
        0
      );

    const remaining =
      items.reduce(
        (n, x) =>
          n +
          Number(
            x.remainingKg || 0
          ),
        0
      );

    const waste =
      Number(
        totalPlateWasteKg ??
          items.reduce(
            (n, x) =>
              n +
              Number(
                x.plateWasteKg || 0
              ),
            0
          )
      );

    /*
     * IMPORTANT:
     * Do not automatically say that all prepared food
     * was consumed while remaining food has not been read.
     *
     * Consumed becomes available only after every food
     * item's remaining weight has been captured.
     */

    const allRemainingCaptured =
      items.length > 0 &&
      items.every(
        x =>
          x.remainingKg != null &&
          Number.isFinite(
            Number(x.remainingKg)
          )
      );

    const consumed =
      allRemainingCaptured
        ? Math.max(
            0,
            prepared -
              remaining -
              waste
          )
        : 0;

    return {
      prepared,
      remaining,
      waste,
      consumed
    };
  }, [
    items,
    totalPlateWasteKg
  ]);

  // ==========================================
  // START NEW MEAL
  // ==========================================

  const startNew = () => {
    setItems([
      EMPTY()
    ]);

    setPreparedLocked(false);

    setRemainingSubmitted(false);

    setTotalPlateWasteKg(null);

    setSavedMealEntryId(null);

    setExpirySaved(false);

    setFinalLocked(false);

    setSelectedHistory(null);

    setTab('entry');
  };

  // ==========================================
  // HISTORY TAB
  // ==========================================

  if (tab === 'history') {
    return (
      <div className="subpage-container meal-page meal-page-premium">

        <div
          className="subpage-header"
          style={{
            alignItems: 'center',
            marginBottom: '22px'
          }}
        >

          <div>

            <h1 className="subpage-title">
              🍛 Meal History
            </h1>

            <p className="subpage-subtitle">
              Review saved meals and their food-wise quantities.
            </p>

          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              flexWrap: 'wrap'
            }}
          >

            <button
              className="btn btn-soft history-back-btn"
              onClick={() =>
                setTab('entry')
              }
            >
              ← Meal Entry
            </button>

            <button
              className="btn btn-primary"
              onClick={startNew}
            >
              + New Meal
            </button>

          </div>

        </div>

        {!selectedHistory ? (

          <section className="card meal-history-card">

            <div
              className="meal-history-head"
              style={{
                paddingBottom: '16px',
                borderBottom:
                  '1px solid #e5e7eb'
              }}
            >

              <div>

                <h2
                  style={{
                    margin: 0
                  }}
                >
                  Saved Meals
                </h2>

                <p
                  className="muted small"
                  style={{
                    margin:
                      '6px 0 0'
                  }}
                >
                  {saved.length} saved record
                  {saved.length === 1
                    ? ''
                    : 's'} for {date}
                </p>

              </div>

              <span className="pill">
                {saved.length} record
                {saved.length === 1
                  ? ''
                  : 's'}
              </span>

            </div>

            {!saved.length ? (

              <div className="empty-state">
                No saved meals for this date.
              </div>

            ) : (

              <div
                style={{
                  display: 'grid',
                  gap: '10px',
                  marginTop: '16px'
                }}
              >

                {saved.map(entry => {

                  const prepared =
                    (
                      entry.items ||
                      []
                    ).reduce(
                      (n, x) =>
                        n +
                        Number(
                          x.preparedKg ||
                            0
                        ),
                      0
                    );

                  const remaining =
                    (
                      entry.items ||
                      []
                    ).reduce(
                      (n, x) =>
                        n +
                        Number(
                          x.remainingKg ||
                            0
                        ),
                      0
                    );

                  return (

                    <button
                      type="button"
                      key={entry.id}
                      onClick={() =>
                        setSelectedHistory(
                          entry
                        )
                      }
                      style={{
                        width: '100%',
                        textAlign:
                          'left',
                        border:
                          '1px solid #e5e7eb',
                        background:
                          '#ffffff',
                        borderRadius:
                          '16px',
                        padding:
                          '18px 20px',
                        cursor:
                          'pointer',
                        display:
                          'flex',
                        alignItems:
                          'center',
                        justifyContent:
                          'space-between',
                        gap: '18px',
                        flexWrap:
                          'wrap'
                      }}
                    >

                      <div>

                        <strong
                          style={{
                            fontSize:
                              '17px',
                            color:
                              '#111827'
                          }}
                        >
                          {entry.mealType ||
                            'Meal'}
                        </strong>

                        <div
                          className="muted small"
                          style={{
                            marginTop:
                              '5px'
                          }}
                        >
                          {entry.date} •{' '}
                          {entry.items
                            ?.length ||
                            0}{' '}
                          food item
                          {(entry.items
                            ?.length ||
                            0) === 1
                            ? ''
                            : 's'}
                        </div>

                      </div>

                      <div
                        style={{
                          display:
                            'flex',
                          gap: '18px',
                          flexWrap:
                            'wrap',
                          color:
                            '#4b5563',
                          fontSize:
                            '13px'
                        }}
                      >

                        <span>
                          <strong>
                            {kg(
                              prepared
                            )}
                          </strong>{' '}
                          prepared
                        </span>

                        <span>
                          <strong>
                            {kg(
                              entry.totalPlateWasteKg ||
                                0
                            )}
                          </strong>{' '}
                          plate waste
                        </span>

                        <span>
                          <strong>
                            {kg(
                              remaining
                            )}
                          </strong>{' '}
                          remaining
                        </span>

                        <span
                          style={{
                            color:
                              '#059669',
                            fontWeight:
                              700
                          }}
                        >
                          View details →
                        </span>

                      </div>

                    </button>

                  );
                })}

              </div>

            )}

          </section>

        ) : (

          <section className="card meal-history-card">

            <div
              style={{
                display:
                  'flex',
                justifyContent:
                  'space-between',
                alignItems:
                  'center',
                gap: '16px',
                flexWrap:
                  'wrap',
                marginBottom:
                  '20px'
              }}
            >

              <div>

                <div className="eyebrow">
                  Saved meal details
                </div>

                <h2
                  style={{
                    margin:
                      '5px 0 4px'
                  }}
                >
                  {selectedHistory.mealType ||
                    'Meal'}
                </h2>

                <p
                  className="muted small"
                  style={{
                    margin: 0
                  }}
                >
                  {selectedHistory.date} •{' '}
                  {selectedHistory.items
                    ?.length ||
                    0}{' '}
                  food item
                  {(selectedHistory.items
                    ?.length ||
                    0) === 1
                    ? ''
                    : 's'}
                </p>

              </div>

              <button
                className="btn btn-soft history-back-btn"
                onClick={() =>
                  setSelectedHistory(
                    null
                  )
                }
              >
                ← Back to History
              </button>

            </div>

            <div
              className="meal-summary-grid"
              style={{
                marginBottom:
                  '22px'
              }}
            >

              <Metric
                title="Total Prepared"
                value={kg(
                  (
                    selectedHistory.items ||
                    []
                  ).reduce(
                    (n, x) =>
                      n +
                      Number(
                        x.preparedKg ||
                          0
                      ),
                    0
                  )
                )}
              />

              <Metric
                title="Total Remaining"
                value={kg(
                  (
                    selectedHistory.items ||
                    []
                  ).reduce(
                    (n, x) =>
                      n +
                      Number(
                        x.remainingKg ||
                          0
                      ),
                    0
                  )
                )}
              />

              <Metric
                title="Total Consumed"
                value={kg(
                  (
                    selectedHistory.items ||
                    []
                  ).reduce(
                    (n, x) =>
                      n +
                      Number(
                        x.consumedKg ||
                          0
                      ),
                    0
                  )
                )}
              />

            </div>

            <div
              className="meal-table-wrap"
              style={{
                overflowX:
                  'auto'
              }}
            >

              <table className="meal-table history-meal-table">

                <colgroup>
                  <col
                    style={{
                      width: '7%'
                    }}
                  />

                  <col
                    style={{
                      width: '21%'
                    }}
                  />

                  <col
                    style={{
                      width: '25%'
                    }}
                  />

                  <col
                    style={{
                      width: '15.67%'
                    }}
                  />

                  <col
                    style={{
                      width: '15.67%'
                    }}
                  />

                  <col
                    style={{
                      width: '15.66%'
                    }}
                  />
                </colgroup>

                <thead>

                  <tr>
                    <th>Item</th>
                    <th>Food Category</th>
                    <th>Food Name</th>
                    <th>Prepared</th>
                    <th>Remaining</th>
                    <th>Consumed</th>
                  </tr>

                </thead>

                <tbody>

                  {(
                    selectedHistory.items ||
                    []
                  ).map(
                    (
                      item,
                      index
                    ) => (

                      <tr
                        key={`${selectedHistory.id}-${index}`}
                      >

                        <td>
                          <strong>
                            {item.itemNumber ||
                              index +
                                1}
                          </strong>
                        </td>

                        <td>
                          {item.category ||
                            'Other'}
                        </td>

                        <td>
                          <strong>
                            {item.name ||
                              `Item ${
                                index +
                                1
                              }`}
                          </strong>
                        </td>

                        <td className="weight-cell">
                          {kg(
                            item.preparedKg
                          )}
                        </td>

                        <td className="weight-cell">
                          {kg(
                            item.remainingKg
                          )}
                        </td>

                        <td className="weight-cell">
                          {kg(
                            item.consumedKg
                          )}
                        </td>

                      </tr>

                    )
                  )}

                </tbody>

              </table>

            </div>

            <div
              style={{
                marginTop:
                  '18px',
                padding:
                  '14px 16px',
                borderRadius:
                  '12px',
                background:
                  '#f8fafc',
                color:
                  '#64748b',
                fontSize:
                  '13px'
              }}
            >

              Plate waste recorded for this meal:{' '}

              <strong
                style={{
                  color:
                    '#111827'
                }}
              >
                {kg(
                  selectedHistory.totalPlateWasteKg ||
                    0
                )}
              </strong>

            </div>

            {selectedHistory.items?.some(
              item =>
                item.expiryTime
            ) && (

              <div
                style={{
                  marginTop:
                    '12px',
                  padding:
                    '14px 16px',
                  borderRadius:
                    '12px',
                  background:
                    '#ecfdf5',
                  color:
                    '#475569',
                  fontSize:
                    '13px'
                }}
              >

                <strong
                  style={{
                    color:
                      '#047857'
                  }}
                >
                  Food Expiry
                </strong>

                <div
                  style={{
                    display:
                      'grid',
                    gap:
                      '7px',
                    marginTop:
                      '10px'
                  }}
                >

                  {selectedHistory.items
                    .filter(
                      item =>
                        item.expiryTime
                    )
                    .map(
                      (
                        item,
                        index
                      ) => (

                        <div
                          key={`history-expiry-${index}`}
                          style={{
                            display:
                              'flex',
                            justifyContent:
                              'space-between',
                            gap:
                              '12px',
                            flexWrap:
                              'wrap'
                          }}
                        >

                          <span>
                            Item{' '}
                            {item.itemNumber ||
                              index +
                                1}:{' '}
                            <strong>
                              {item.name ||
                                'Food Item'}
                            </strong>
                          </span>

                          <span>
                            {item.expiryHours ||
                              2}{' '}
                            hour(s) •{' '}
                            {new Date(
                              item.expiryTime
                            ).toLocaleString()}
                          </span>

                        </div>

                      )
                    )}

                </div>

              </div>

            )}

          </section>

        )}

      </div>
    );
  }

  // ==========================================
  // MAIN MEAL ENTRY PAGE
  // ==========================================

  return (
    <div className="subpage-container meal-page meal-page-premium">

      <MealTableAlignmentStyles />

      <div
        className="subpage-header"
        style={{
          alignItems:
            'center',
          marginBottom:
            '22px'
        }}
      >

        <div>

          <h1 className="subpage-title">
            🍛 Meal Entry
          </h1>

          <p className="subpage-subtitle">
            Record prepared food and remaining food for today’s meal.
          </p>

        </div>

        <button
          className="btn btn-soft"
          onClick={() =>
            setTab('history')
          }
          style={{
            borderRadius:
              '12px',
            whiteSpace:
              'nowrap'
          }}
        >
          ↺ History
        </button>

      </div>

      {/* ======================================
          MEAL CONTROLS
      ======================================= */}

      <section
        className="card meal-controls"
        style={{
          marginTop:
            '4px',
          padding:
            '22px 24px',
          borderRadius:
            '18px'
        }}
      >

        <label>

          <span>Date</span>

          <input
            className="input"
            type="date"
            value={date}
            onChange={e =>
              setDate(
                e.target.value
              )
            }
            disabled={
              preparedLocked
            }
          />

        </label>

        <label>

          <span>Meal Type</span>

          <select
            className="input"
            value={mealType}
            onChange={e =>
              setMealType(
                e.target.value
              )
            }
            disabled={
              preparedLocked
            }
          >

            {MEALS.map(m => (
              <option key={m}>
                {m}
              </option>
            ))}

          </select>

        </label>

      </section>

      {/* ======================================
          LIVE WEIGHT
      ======================================= */}

      <section
        className="card"
        style={{
          marginTop:
            '16px',
          padding:
            '22px 24px',
          display:
            'flex',
          alignItems:
            'center',
          justifyContent:
            'space-between',
          gap:
            '20px',
          flexWrap:
            'wrap',
          background:
            'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)'
        }}
      >

        <div>

          <div className="eyebrow">
            LIVE WEIGHT
          </div>

          <h2
            style={{
              margin:
                '6px 0 0',
              fontSize:
                '22px',
              letterSpacing:
                '-0.02em'
            }}
          >
            Live reading of weight
          </h2>

          <p
            className="muted small"
            style={{
              margin:
                '5px 0 0'
            }}
          >
            The current weight is updated automatically.
          </p>

        </div>

        <div
          style={{
            minWidth:
              '190px',
            textAlign:
              'right'
          }}
        >

          <div
            style={{
              fontSize:
                '34px',
              fontWeight:
                800,
              lineHeight:
                1.05,
              color:
                '#111827'
            }}
          >

            {liveWeightKg ==
            null
              ? '—'
              : `${liveWeightKg.toFixed(
                  3
                )} kg`}

          </div>

          <div
            className="muted small"
            style={{
              marginTop:
                '7px'
            }}
          >

            {liveWeightStatus ===
            'live'
              ? `● Live • ${(
                  liveWeightKg *
                  1000
                ).toFixed(
                  1
                )} g`
              : liveWeightStatus ===
                'waiting'
              ? 'Waiting for live reading…'
              : 'Connecting…'}

          </div>

        </div>

      </section>

      {/* ======================================
          SUMMARY
      ======================================= */}

      <section className="meal-summary-grid">

        <Metric
          title="Total Prepared"
          value={kg(
            totals.prepared
          )}
        />

        <Metric
          title="Total Consumed"
          value={kg(
            totals.consumed
          )}
        />

        <Metric
          title="Food Remaining"
          value={kg(
            totals.remaining
          )}
        />

      </section>

      {/* ======================================
          TWO COLUMN MEAL AREA
      ======================================= */}

      <div className="meal-two-col">

        {/* ====================================
            FOOD PREPARED
        ===================================== */}

        <section className="card meal-panel">

          <div className="meal-panel-head">

            <div>

              <h2>
                🍲 Food Prepared
              </h2>

              <p className="muted">
                Add each prepared food and capture its weight.
              </p>

            </div>

            {preparedLocked && (
              <span className="status-pill locked">
                🔒 Locked
              </span>
            )}

          </div>

          <div className="meal-table-wrap">

            <table className="meal-table prepared-meal-table">

              <colgroup>

                <col
                  style={{
                    width:
                      '7%'
                  }}
                />

                <col
                  style={{
                    width:
                      '23%'
                  }}
                />

                <col
                  style={{
                    width:
                      '30%'
                  }}
                />

                <col
                  style={{
                    width:
                      '18%'
                  }}
                />

                <col
                  style={{
                    width:
                      '22%'
                  }}
                />

              </colgroup>

              <thead>

                <tr>
                  <th>Item</th>
                  <th>Food Category</th>
                  <th>Food Name</th>
                  <th>Prepared</th>
                  <th>Action</th>
                </tr>

              </thead>

              <tbody>

                {items.map(
                  (
                    item,
                    i
                  ) => (

                    <tr key={i}>

                      <td>
                        <strong>
                          {i + 1}
                        </strong>
                      </td>

                      <td>

                        <select
                          className="input compact"
                          value={
                            item.category
                          }
                          disabled={
                            preparedLocked
                          }
                          onChange={e =>
                            updateItem(
                              i,
                              {
                                category:
                                  e.target.value
                              }
                            )
                          }
                        >

                          {CATEGORIES.map(
                            c => (
                              <option
                                key={c}
                              >
                                {c}
                              </option>
                            )
                          )}

                        </select>

                      </td>

                      <td>

                        <input
                          className="input compact"
                          value={
                            item.name
                          }
                          disabled={
                            preparedLocked
                          }
                          onChange={e =>
                            updateItem(
                              i,
                              {
                                name:
                                  e.target.value
                              }
                            )
                          }
                          placeholder="Rice / Aloo Sabzi / Roti"
                        />

                      </td>

                      <td className="weight-cell">
                        {kg(
                          item.preparedKg
                        )}
                      </td>

                      <td className="action-cell">

                        <button
                          className="btn btn-soft compact-btn"
                          disabled={
                            preparedLocked ||
                            capturing ===
                              `${i}:preparedKg`
                          }
                          onClick={() =>
                            capture(
                              i,
                              'preparedKg'
                            )
                          }
                        >

                          {capturing ===
                          `${i}:preparedKg`
                            ? 'Reading…'
                            : '⚖️ Read'}

                        </button>

                      </td>

                    </tr>

                  )
                )}

              </tbody>

            </table>

          </div>

          {!preparedLocked && (

            <div
              className="workflow-actions"
              style={{
                display:
                  'flex',
                gap:
                  '10px',
                justifyContent:
                  'flex-end',
                alignItems:
                  'center',
                flexWrap:
                  'wrap',
                marginTop:
                  '16px'
              }}
            >

              <button
                type="button"
                className="btn btn-secondary"
                onClick={
                  addNext
                }
              >
                ＋ Next Item
              </button>

              <button
                type="button"
                className="btn btn-primary"
                onClick={
                  submitPrepared
                }
              >
                🔒 Submit &amp; Lock Prepared
              </button>

            </div>

          )}

        </section>

        {/* ====================================
            FOOD REMAINING
        ===================================== */}

        <section className="card meal-panel">

          <div className="meal-panel-head">

            <div>

              <h2>
                🥗 Food Remaining
              </h2>

            </div>

            {remainingSubmitted && (
              <span className="status-pill done">
                ✓ Submitted
              </span>
            )}

          </div>

          <div className="meal-table-wrap">

            <table className="meal-table remaining-meal-table">

              <colgroup>

                <col
                  style={{
                    width:
                      '8%'
                  }}
                />

                <col
                  style={{
                    width:
                      '32%'
                  }}
                />

                <col
                  style={{
                    width:
                      '18%'
                  }}
                />

                <col
                  style={{
                    width:
                      '20%'
                  }}
                />

                <col
                  style={{
                    width:
                      '22%'
                  }}
                />

              </colgroup>

              <thead>

                <tr>
                  <th>Item</th>
                  <th>Food</th>
                  <th>Prepared</th>
                  <th>Remaining</th>
                  <th>Action</th>
                </tr>

              </thead>

              <tbody>

                {items.map(
                  (
                    item,
                    i
                  ) => (

                    <tr key={i}>

                      <td>
                        <strong>
                          {i + 1}
                        </strong>
                      </td>

                      <td>
                        {item.name ||
                          '—'}
                      </td>

                      <td className="weight-cell">
                        {kg(
                          item.preparedKg
                        )}
                      </td>

                      <td className="weight-cell">
                        {kg(
                          item.remainingKg
                        )}
                      </td>

                      <td className="action-cell">

                        <button
                          className="btn btn-soft compact-btn"
                          disabled={
                            !preparedLocked ||
                            capturing ===
                              `${i}:remainingKg`
                          }
                          onClick={() =>
                            capture(
                              i,
                              'remainingKg'
                            )
                          }
                        >

                          {capturing ===
                          `${i}:remainingKg`
                            ? 'Reading…'
                            : '⚖️ Read'}

                        </button>

                      </td>

                    </tr>

                  )
                )}

              </tbody>

            </table>

          </div>

          {preparedLocked &&
            !remainingSubmitted && (

              <div
                className="workflow-actions"
                style={{
                  display:
                    'flex',
                  gap:
                    '10px',
                  justifyContent:
                    'flex-end',
                  alignItems:
                    'center',
                  flexWrap:
                    'wrap',
                  marginTop:
                    '16px'
                }}
              >

                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={
                    addNextFromRemaining
                  }
                >
                  ＋ Next Item
                </button>

                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={
                    submitRemaining
                  }
                >
                  ✓ Submit Remaining
                </button>

              </div>

            )}

        </section>

      </div>

            {/* ======================================
          PLATE WASTE
      ======================================= */}

      <section className="card plate-waste-panel">

        <div className="plate-waste-head">

          <div>

            <div className="eyebrow">
              Main Output
            </div>

            <h2>
              🗑️ Plate Waste
            </h2>

            <p className="muted">
              Capture plate waste for each food item using the Load Cell.
            </p>

          </div>

          <button
            className="btn btn-primary"
            disabled={
              !preparedLocked ||
              capturing === 'total-waste'
            }
            onClick={
              captureTotalPlateWaste
            }
          >

            {capturing ===
            'total-waste'
              ? 'Reading…'
              : '⚖️ Read Total Waste'}

          </button>

        </div>

        <div className="meal-table-wrap">

          <table className="meal-table plate-waste-table">

            <colgroup>

              <col
                style={{
                  width: '25%'
                }}
              />

              <col
                style={{
                  width: '15%'
                }}
              />

              <col
                style={{
                  width: '17%'
                }}
              />

              <col
                style={{
                  width: '15%'
                }}
              />

              <col
                style={{
                  width: '13%'
                }}
              />

              <col
                style={{
                  width: '15%'
                }}
              />

            </colgroup>

            <thead>

              <tr>
                <th>Food Item</th>
                <th>Prepared</th>
                <th>Waste</th>
                <th>Remaining</th>
                <th>Consumed</th>
                <th>Action</th>
              </tr>

            </thead>

            <tbody>

              {items.map(
                (
                  item,
                  i
                ) => {

                  const prepared =
                    Number(
                      item.preparedKg ||
                        0
                    );

                  const remaining =
                    Number(
                      item.remainingKg ||
                        0
                    );

                  const waste =
                    Number(
                      item.plateWasteKg ||
                        0
                    );

                  const consumed =
                    item.remainingKg !=
                    null
                      ? Math.max(
                          0,
                          prepared -
                            remaining -
                            waste
                        )
                      : 0;

                  return (

                    <tr
                      key={`plate-waste-${i}`}
                    >

                      <td>

                        <strong>
                          {item.name ||
                            `Item ${
                              i + 1
                            }`}
                        </strong>

                      </td>

                      <td className="weight-cell">
                        {kg(
                          item.preparedKg
                        )}
                      </td>

                      <td className="weight-cell">
                        {kg(
                          item.plateWasteKg
                        )}
                      </td>

                      <td className="weight-cell">
                        {kg(
                          item.remainingKg
                        )}
                      </td>

                      <td className="weight-cell">
                        {item.remainingKg !=
                        null
                          ? kg(
                              consumed
                            )
                          : '—'}
                      </td>

                      <td className="action-cell">

                        <button
                          className="btn btn-soft compact-btn"
                          disabled={
                            !preparedLocked ||
                            capturing ===
                              `${i}:plateWasteKg`
                          }
                          onClick={() =>
                            capture(
                              i,
                              'plateWasteKg'
                            )
                          }
                        >

                          {capturing ===
                          `${i}:plateWasteKg`
                            ? 'Reading…'
                            : '⚖️ Read Waste'}

                        </button>

                      </td>

                    </tr>

                  );
                }
              )}

            </tbody>

          </table>

        </div>

      </section>

      {/* ======================================
          FOOD FRESHNESS / EXPIRY
      ======================================= */}

      <section
        className="card"
        style={{
          marginTop:
            '18px',
          padding:
            '24px',
          borderRadius:
            '18px',
          border:
            '1px solid rgba(16,185,129,.18)',
          background:
            'linear-gradient(135deg, rgba(236,253,245,.96), rgba(255,251,235,.96))'
        }}
      >

        <div
          style={{
            display:
              'flex',
            alignItems:
              'flex-start',
            justifyContent:
              'space-between',
            gap:
              '18px',
            flexWrap:
              'wrap',
            marginBottom:
              '18px'
          }}
        >

          <div>

            <div className="eyebrow">
              FINAL STEP
            </div>

            <h2
              style={{
                margin:
                  '5px 0 6px'
              }}
            >
              🕒 Food Freshness / Expiry
            </h2>

            <p
              className="muted"
              style={{
                margin: 0
              }}
            >
              Enter how many hours each food item can safely remain available. Default is 2 hours; you can change it manually.
            </p>

          </div>

        </div>

        <div
          className="meal-table-wrap"
          style={{
            overflowX:
              'auto'
          }}
        >

          <table
            className="meal-table"
            style={{
              minWidth:
                '860px'
            }}
          >

            <colgroup>

              <col
                style={{
                  width:
                    '9%'
                }}
              />

              <col
                style={{
                  width:
                    '33%'
                }}
              />

              <col
                style={{
                  width:
                    '18%'
                }}
              />

              <col
                style={{
                  width:
                    '20%'
                }}
              />

              <col
                style={{
                  width:
                    '20%'
                }}
              />

            </colgroup>

            <thead>

              <tr>
                <th>Item No.</th>
                <th>Food Item</th>
                <th>Valid For (Hours)</th>
                <th>Remaining Captured</th>
                <th>Expiry</th>
              </tr>

            </thead>

            <tbody>

              {items.map(
                (
                  item,
                  i
                ) => {

                  const expiresAt =
                    item.expiryTime
                      ? new Date(
                          item.expiryTime
                        )
                      : null;

                  return (

                    <tr
                      key={`expiry-${i}`}
                    >

                      <td>
                        <strong>
                          {i + 1}
                        </strong>
                      </td>

                      <td>

                        <input
                          className="input compact"
                          value={
                            item.name
                          }
                          disabled={
                            finalLocked
                          }
                          onChange={e => {
                            updateItem(
                              i,
                              {
                                name:
                                  e.target.value
                              }
                            );

                            setExpirySaved(
                              false
                            );

                            setFinalLocked(
                              false
                            );
                          }}
                          placeholder={`Food Item ${
                            i + 1
                          }`}
                        />

                      </td>

                      <td>

                        <div
                          style={{
                            display:
                              'flex',
                            alignItems:
                              'center',
                            gap:
                              '8px'
                          }}
                        >

                          <input
                            className="input compact"
                            type="number"
                            min="0.5"
                            step="0.5"
                            value={
                              item.expiryHours ??
                              2
                            }
                            disabled={
                              finalLocked ||
                              expirySaved
                            }
                            onChange={e => {
                              updateItem(
                                i,
                                {
                                  expiryHours:
                                    e.target.value
                                }
                              );

                              setExpirySaved(
                                false
                              );

                              setFinalLocked(
                                false
                              );
                            }}
                            style={{
                              maxWidth:
                                '130px'
                            }}
                          />

                          <span className="muted small">
                            hours
                          </span>

                        </div>

                      </td>

                      <td className="muted small">

                        {item.remainingCapturedAt
                          ? new Date(
                              item.remainingCapturedAt
                            ).toLocaleString()
                          : '—'}

                      </td>

                      <td>

                        {expiresAt &&
                        !Number.isNaN(
                          expiresAt.getTime()
                        ) ? (

                          <div>

                            <strong>
                              {expiresAt.toLocaleString()}
                            </strong>

                            <div
                              className="muted small"
                              style={{
                                marginTop:
                                  '4px'
                              }}
                            >
                              {Math.max(
                                0,
                                Math.round(
                                  (
                                    expiresAt.getTime() -
                                    Date.now()
                                  ) /
                                    60000
                                )
                              )}{' '}
                              min from now
                            </div>

                          </div>

                        ) : (

                          <span className="muted">
                            —
                          </span>

                        )}

                      </td>

                    </tr>

                  );
                }
              )}

            </tbody>

          </table>

        </div>

        <div
          style={{
            display:
              'flex',
            justifyContent:
              'flex-end',
            gap:
              '10px',
            flexWrap:
              'wrap',
            marginTop:
              '18px'
          }}
        >

          <button
            type="button"
            className="btn btn-primary"
            onClick={
              saveFoodExpiry
            }
            disabled={
              finalLocked
            }
          >
            🕒 Save Food Expiry
          </button>

        </div>

        <div
          className="muted small"
          style={{
            marginTop:
              '12px',
            lineHeight:
              1.5
          }}
        >
          Example: enter <strong>2</strong> hours for an item that should be available for two hours after its remaining-weight reading. You can enter 0.5, 1, 1.5, 2, 3, 4, etc.
        </div>

      </section>

    </div>
  );
}

/* ==========================================
   MEAL TABLE ALIGNMENT
========================================== */

const MealTableAlignmentStyles = () => (
  <style>{`
    .meal-page-premium {
      position: relative;
      min-height: 100vh;
      overflow: hidden;
      background:
        radial-gradient(circle at 8% 8%, rgba(187,247,208,.55), transparent 28%),
        radial-gradient(circle at 92% 10%, rgba(254,240,138,.42), transparent 25%),
        radial-gradient(circle at 80% 88%, rgba(167,243,208,.34), transparent 30%),
        linear-gradient(135deg, #f6fff9 0%, #fffdf2 48%, #f3fff8 100%);
    }

    .meal-page-premium::before {
      content: '';
      position: absolute;
      width: 430px;
      height: 430px;
      right: -190px;
      top: 100px;
      border-radius: 50%;
      background: rgba(52,211,153,.12);
      filter: blur(10px);
      pointer-events: none;
    }

    .meal-page-premium::after {
      content: '';
      position: absolute;
      width: 380px;
      height: 380px;
      left: -190px;
      bottom: 20px;
      border-radius: 50%;
      background: rgba(250,204,21,.10);
      filter: blur(10px);
      pointer-events: none;
    }

    .meal-page-premium > * {
      position: relative;
      z-index: 1;
    }

    .meal-page-premium .card {
      border: 1px solid rgba(16,185,129,.13) !important;
      background: rgba(255,255,255,.90) !important;
      box-shadow:
        0 20px 48px rgba(15,23,42,.07),
        0 4px 14px rgba(16,185,129,.06) !important;
      backdrop-filter: blur(14px);
    }

    .meal-page-premium .meal-controls {
      background: linear-gradient(
        135deg,
        rgba(236,253,245,.96),
        rgba(255,251,235,.96)
      ) !important;
      border-color: rgba(16,185,129,.18) !important;
    }

    .meal-page-premium .meal-panel:hover {
      transform: translateY(-2px);
      transition: transform .2s ease, box-shadow .2s ease;
      box-shadow:
        0 24px 52px rgba(15,23,42,.09),
        0 5px 16px rgba(16,185,129,.08) !important;
    }

    .meal-page-premium .subpage-title {
      font-weight: 850;
      letter-spacing: -.035em;
    }

    .meal-page-premium .eyebrow {
      color: #059669;
      letter-spacing: .14em;
      font-weight: 800;
    }

    .meal-page-premium .history-back-btn {
      border: 1px solid rgba(16,185,129,.20);
      background: rgba(255,255,255,.86);
      color: #047857;
      box-shadow: 0 8px 20px rgba(15,23,42,.05);
    }

    .meal-page-premium .history-back-btn:hover {
      background: #ecfdf5;
      transform: translateY(-1px);
    }

    .meal-grid-wrap {
      width: 100%;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      border-radius: 16px;
    }

    .meal-grid-table {
      display: grid;
      width: 100%;
      min-width: 720px;
      overflow: hidden;
      border: 1px solid #e5e7eb;
      border-radius: 16px;
      background: rgba(255,255,255,.78);
    }

    .meal-grid-row {
      display: grid;
      width: 100%;
      min-height: 58px;
      align-items: center;
      border-top: 1px solid #edf2f7;
    }

    .meal-grid-row:first-child {
      border-top: 0;
    }

    .meal-grid-head {
      min-height: 48px;
      background: linear-gradient(
        90deg,
        rgba(236,253,245,.95),
        rgba(255,251,235,.92)
      );
      color: #64748b;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: .075em; a
      text-transform: uppercase;
    }

    .meal-grid-cell {
      min-width: 0;
      box-sizing: border-box;
      padding: 13px 14px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: #334155;
    }

    .meal-grid-cell.number {
      text-align: right;
      font-variant-numeric: tabular-nums;
      font-weight: 650;
      color: #172033;
    }

    .meal-grid-cell.action {
      text-align: center;
    }

    .meal-grid-table.history-grid {
      min-width: 820px;
    }

    .meal-grid-table.history-grid .meal-grid-row {
      grid-template-columns: 7% 21% 25% 15.67% 15.67% 15.66%;
    }

    .meal-grid-table.prepared-grid {
      min-width: 760px;
    }

    .meal-grid-table.prepared-grid .meal-grid-row {
      grid-template-columns: 7% 23% 30% 18% 22%;
    }

    .meal-grid-table.remaining-grid {
      min-width: 700px;
    }

    .meal-grid-table.remaining-grid .meal-grid-row {
      grid-template-columns: 8% 32% 18% 20% 22%;
    }

    .meal-grid-cell .input.compact {
      display: block;
      width: 100%;
      min-width: 0;
      max-width: 100%;
      box-sizing: border-box;
    }

    .meal-grid-cell .compact-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 88px;
      max-width: 100%;
      white-space: nowrap;
    }

    .meal-grid-row.data-row:hover {
      background: rgba(236,253,245,.35);
    }

    @media (max-width: 760px) {
      .meal-page-premium {
        background:
          radial-gradient(circle at 10% 5%, rgba(187,247,208,.45), transparent 32%),
          radial-gradient(circle at 95% 10%, rgba(254,240,138,.32), transparent 30%),
          linear-gradient(135deg, #f8fffa, #fffef5);
      }

      .meal-grid-cell {
        padding: 11px 10px;
      }
    }

    .meal-page-premium .plate-waste-panel {
      margin-top: 18px;
    }

    .meal-page-premium .plate-waste-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 18px;
      margin-bottom: 18px;
    }

    .meal-page-premium .plate-waste-head h2 {
      margin: 4px 0 6px;
    }

    .meal-page-premium .plate-waste-head p {
      margin: 0;
    }

    .meal-page-premium .plate-waste-table {
      min-width: 760px;
    }

    .meal-page-premium .workflow-actions {
      border-top: 1px solid #edf2f7;
      padding-top: 14px;
    }

    .meal-page-premium .workflow-actions .btn {
      min-height: 42px;
      border-radius: 11px;
      white-space: nowrap;
    }

    .meal-page-premium .expiry-card {
      margin-top: 18px;
    }

    @media (max-width: 760px) {
      .meal-page-premium .plate-waste-head {
        flex-direction: column;
      }

      .meal-page-premium .plate-waste-head .btn {
        width: 100%;
      }
    }

    .meal-page-premium .meal-table {
      width: 100% !important;
      table-layout: fixed !important;
      border-collapse: collapse !important;
      border-spacing: 0 !important;
    }

    .meal-page-premium .meal-table th,
    .meal-page-premium .meal-table td,
    .meal-page-premium .meal-table td.weight-cell,
    .meal-page-premium .meal-table td.action-cell {
      text-align: left !important;
      vertical-align: middle !important;
      box-sizing: border-box !important;
      padding: 12px 14px !important;
    }

    .meal-page-premium .meal-table th {
      color: #64748b !important;
      font-size: 11px !important;
      font-weight: 800 !important;
      letter-spacing: .06em !important;
      text-transform: uppercase !important;
    }

    .meal-page-premium .meal-table .input.compact {
      width: 100% !important;
      min-width: 0 !important;
      box-sizing: border-box !important;
    }

    .meal-page-premium .meal-table tbody tr:hover {
      background: rgba(236,253,245,.34) !important;
    }

    @media (max-width: 760px) {
      .meal-page-premium .meal-table {
        min-width: 720px !important;
      }
    }
  `}</style>
);

// ==========================================
// METRIC COMPONENT
// ==========================================

function Metric({
  title,
  value
}) {
  return (
    <div className="meal-metric">w
      <span>{title}</span>
      <strong>{value}</strong>
    </div>
  );
} 