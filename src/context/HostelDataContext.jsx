/* eslint-disable react-refresh/only-export-components */

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef
} from 'react';

import { db } from '../config/firebase';

import {
  collection,
  query,
  where,
  onSnapshot,
  addDoc,
  serverTimestamp,
  doc,
  updateDoc,
  deleteDoc
} from 'firebase/firestore';

import { useAuth } from './AuthContext';

import {
  requestNotificationPermission,
  sendNotification
} from '../utils/notifications.jsx';

import {
  computeCoreMetrics,
  computeRescueFunnel,
  computeBaselineComparison,
  detectCategoryFromTitle
} from '../utils/analyticsEngine';

import {
  calculateImpactTelemetry,
  calculateImpactTimeSeries
} from '../utils/impactCalculator';


/* =========================================================
   FOOD FRESHNESS / SPOILAGE HELPERS
   ---------------------------------------------------------
   These are additive helpers. Existing app functionality is
   preserved; freshness fields are simply added to listings/logs.
========================================================= */

const getDefaultFreshnessMinutes = (log = {}) => {
  const category = String(
    log.categoryLabel ||
    log.category ||
    ''
  ).toLowerCase();

  const foodName = String(
    log.foodItem ||
    log.title ||
    ''
  ).toLowerCase();

  // More perishable food → 1.5 hour default.
  if (
    category.includes('dairy') ||
    category.includes('curd') ||
    category.includes('vegetable') ||
    category.includes('sabzi') ||
    category.includes('snack') ||
    foodName.includes('curd') ||
    foodName.includes('milk') ||
    foodName.includes('paneer') ||
    foodName.includes('raita')
  ) {
    return 90;
  }

  // Rice/grains, dal, roti/bread and other food → 2 hours.
  return 120;
};

const getValidDate = (value) => {
  if (!value) return null;

  try {
    const d = value?.toDate
      ? value.toDate()
      : new Date(value);

    return Number.isNaN(d.getTime())
      ? null
      : d;
  } catch {
    return null;
  }
};

const resolveFoodExpiry = (log = {}, fallbackNow = new Date()) => {
  const explicitExpiry = getValidDate(log.expiryTime);

  const requestedMinutes = Number(
    log.freshnessMinutes ??
    log.validityMinutes ??
    0
  );

  const freshnessMinutes =
    Number.isFinite(requestedMinutes) && requestedMinutes > 0
      ? Math.max(30, Math.min(240, Math.round(requestedMinutes)))
      : getDefaultFreshnessMinutes(log);

  if (explicitExpiry) {
    return {
      expiryTime: explicitExpiry,
      freshnessMinutes,
      freshnessSource: 'Donor specified / existing value'
    };
  }

  /*
   * Actual preparation time should be preferred when available.
   * This lets a donor say: food was prepared in the morning.
   * If that is not stored yet, use the remaining-capture time,
   * then the log creation time, then current time.
   */
  const baseTime =
    getValidDate(log.foodPreparedAt) ||
    getValidDate(log.preparedAt) ||
    getValidDate(log.remainingCapturedAt) ||
    getValidDate(log.createdAt) ||
    fallbackNow;

  return {
    expiryTime: new Date(
      baseTime.getTime() +
      freshnessMinutes * 60 * 1000
    ),
    freshnessMinutes,
    freshnessSource: 'Default freshness window'
  };
};


const HostelDataContext = createContext();


export const useHostelData = () => useContext(HostelDataContext);


export const HostelDataProvider = ({ children }) => {

  const { currentUser, userData } = useAuth();

  const [listings, setListings] = useState([]);
  const [logs, setLogs] = useState([]);
  const [allLogs, setAllLogs] = useState([]);
  const [actions, setActions] = useState([]);
  const [loading, setLoading] = useState(true);

  const previousListingsRef = useRef(new Map());


  // =========================================================
  // FIRESTORE REAL-TIME DATA
  // =========================================================

  useEffect(() => {

    if (!currentUser || !db) {
      Promise.resolve().then(() => setLoading(false));
      return;
    }

    requestNotificationPermission();

    let unsubscribeListings = null;
    let unsubscribeLogs = null;
    let unsubscribeActions = null;

    try {

      // =======================================================
      // 1. ACTIVE LISTINGS
      // =======================================================

      const qListings = query(
        collection(db, 'listings'),
        where('hostelId', '==', currentUser.uid)
      );

      unsubscribeListings = onSnapshot(
        qListings,
        (snap) => {

          const fetched = snap.docs.map(d => ({
            id: d.id,
            ...d.data()
          }));


          const prevMap = previousListingsRef.current;


          // Notification on status transitions
          if (prevMap.size > 0) {

            fetched.forEach(listing => {

              const prevListing = prevMap.get(listing.id);

              if (!prevListing) return;


              if (
                prevListing.status === 'Available' &&
                listing.status === 'Accepted'
              ) {

                sendNotification(
                  'Order Accepted! 🎉',
                  `${listing.ngoName || 'An NGO'} has accepted your pickup for ${listing.title}.`
                );

              }


              if (
                prevListing.status === 'Accepted' &&
                listing.status === 'Picked Up'
              ) {

                sendNotification(
                  'Pickup Completed! ✅',
                  `Your donation of ${listing.title} has been successfully picked up.`
                );

              }

            });

          }


          const newMap = new Map();

          fetched.forEach(listing => {
            newMap.set(listing.id, listing);
          });

          previousListingsRef.current = newMap;


          fetched.sort(
            (a, b) =>
              (b.createdAt?.toMillis?.() || Date.now()) -
              (a.createdAt?.toMillis?.() || Date.now())
          );


          setListings([...fetched]);

        },
        (err) => {
          console.warn('Listings snapshot warning:', err);
        }
      );


      // =======================================================
      // 2. FOOD LOGS
      // =======================================================

      // Historical Food Logs gets its data from this collection.
      //
      // Meal Entry also saves directly into this same collection.
      //
      // Flow:
      //
      // Meal Entry
      //     ↓
      // foodLogs
      //     ↓
      // allLogs
      //     ↓
      // Historical Food Logs

      const qLogs = query(
        collection(db, 'foodLogs'),
        where('hostelId', '==', currentUser.uid)
      );


      unsubscribeLogs = onSnapshot(
        qLogs,
        (snap) => {

          const now = Date.now();


          const fetchedLogs = snap.docs.map(d => {

            const data = d.data();

            // Keep every field stored in Firestore.
            // This is important for Meal Entry fields such as:
            // source, sourceLabel, mealBatchId,
            // mealDate, itemNumber, preparedKg,
            // remainingKg, consumedKg, plateWasteKg, etc.

            return {
              id: d.id,
              ...data
            };

          });


          const sorted = fetchedLogs.sort(
            (a, b) =>
              (b.createdAt?.toMillis?.() || now) -
              (a.createdAt?.toMillis?.() || now)
          );


          // Complete food log history
          setAllLogs([...sorted]);


          // Recent logs used elsewhere in dashboard
          setLogs(
            [...sorted.slice(0, 30)].reverse()
          );


          setLoading(false);

        },
        (err) => {

          console.warn(
            'FoodLogs snapshot warning:',
            err
          );

          setLoading(false);

        }
      );


      // =======================================================
      // 3. AI ACTIONS
      // =======================================================

      const qActions = query(
        collection(db, 'actions'),
        where('hostelId', '==', currentUser.uid)
      );


      unsubscribeActions = onSnapshot(
        qActions,
        (snap) => {

          const fetchedActions = snap.docs.map(d => ({
            id: d.id,
            ...d.data()
          }));


          fetchedActions.sort(
            (a, b) =>
              (b.createdAt?.toMillis?.() || Date.now()) -
              (a.createdAt?.toMillis?.() || Date.now())
          );


          setActions([...fetchedActions]);

        },
        (err) => {

          console.warn(
            'Actions snapshot warning:',
            err
          );

        }
      );


    } catch (e) {

      console.error(
        'HostelDataProvider setup error:',
        e
      );

      setLoading(false);

    }


    return () => {

      if (unsubscribeListings) {
        unsubscribeListings();
      }

      if (unsubscribeLogs) {
        unsubscribeLogs();
      }

      if (unsubscribeActions) {
        unsubscribeActions();
      }

    };

  }, [currentUser]);


  // =========================================================
  // CORE KPIs
  // =========================================================

  const kpis = useMemo(() => {

    return computeCoreMetrics(
      allLogs,
      listings
    );

  }, [allLogs, listings]);


  // =========================================================
  // FOOD RESCUE FUNNEL
  // =========================================================

  const rescueFunnel = useMemo(() => {

    return computeRescueFunnel(
      allLogs,
      listings
    );

  }, [allLogs, listings]);


  // =========================================================
  // IMPACT TELEMETRY
  // =========================================================

  const impactTelemetry = useMemo(() => {

    return calculateImpactTelemetry(
      listings,
      allLogs
    );

  }, [listings, allLogs]);


  // =========================================================
  // IMPACT TIME SERIES
  // =========================================================

  const impactTimeSeries = useMemo(() => {

    return calculateImpactTimeSeries(
      listings
    );

  }, [listings]);


  // =========================================================
  // 7-DAY BASELINE
  // =========================================================

  const baseline7Days = useMemo(() => {

    return computeBaselineComparison(
      allLogs,
      7
    );

  }, [allLogs]);


  // =========================================================
  // ADD FOOD LOG
  // =========================================================

  // Kept for compatibility with any other existing part
  // of the project that may still use addFoodLog().
  //
  // Meal Entry DOES NOT need this function.
  // Meal Entry writes directly to foodLogs.

  const addFoodLog = useCallback(
    async ({
      foodItem,
      mealType,
      category,
      prepared,
      consumed,
      wasteType = 'overproduction',
      unit = 'portions',
      freshnessMinutes = null,
      validityMinutes = null,
      foodPreparedAt = null,
      preparedAt = null,
      remainingCapturedAt = null,
      expiryTime = null,
      perishability = null
    }) => {

      if (!currentUser) {
        throw new Error('Not authenticated');
      }


      const surplusVal = Math.max(
        0,
        Number(prepared) - Number(consumed)
      );


      // Keep the existing quantity-based donor priority for compatibility.
      const priority =
        surplusVal >= 20
          ? 'High'
          : surplusVal >= 10
            ? 'Medium'
            : 'Low';


      const now = new Date();

      const freshnessLog = {
        foodItem,
        category,
        title: `${mealType} - ${foodItem}`,
        freshnessMinutes: freshnessMinutes ?? validityMinutes,
        foodPreparedAt,
        preparedAt,
        remainingCapturedAt,
        expiryTime,
        perishability
      };

      const resolvedFreshness =
        resolveFoodExpiry(
          freshnessLog,
          now
        );

      const calculatedExpiryTime =
        resolvedFreshness.expiryTime;

      const resolvedFreshnessMinutes =
        resolvedFreshness.freshnessMinutes;

      const freshnessSource =
        resolvedFreshness.freshnessSource;


      const fullTitle =
        `${mealType} - ${foodItem}`;


      const detectedCategory =
        category ||
        detectCategoryFromTitle(foodItem);


      if (!db) {

        console.warn(
          'Firestore not initialized'
        );

        return {
          surplus: surplusVal
        };

      }


      // =======================================================
      // SAVE TO FOOD LOGS
      // =======================================================

      const logDocRef = await addDoc(
        collection(db, 'foodLogs'),
        {

          hostelId: currentUser.uid,

          hostelName:
            userData?.name ||
            'My Hostel',

          title: fullTitle,

          foodItem,

          mealType,

          category: detectedCategory,

          prepared: Number(prepared),

          consumed: Number(consumed),

          surplus: surplusVal,

          wasteType,

          unit,

          // -------------------------------------------------
          // FOOD FRESHNESS / EXPIRY
          // -------------------------------------------------

          freshnessMinutes: resolvedFreshnessMinutes,

          validityMinutes: resolvedFreshnessMinutes,

          freshnessSource,

          foodPreparedAt:
            foodPreparedAt ||
            preparedAt ||
            null,

          preparedAt:
            preparedAt ||
            foodPreparedAt ||
            null,

          remainingCapturedAt:
            remainingCapturedAt ||
            now.toISOString(),

          expiryTime:
            calculatedExpiryTime.toISOString(),

          perishability:
            perishability ||
            null,

          status:
            surplusVal > 0
              ? 'pending'
              : 'zero-waste',

          source: 'legacy/manual',

          sourceLabel: 'Manual',

          createdAt:
            serverTimestamp()

        }
      );


      // =======================================================
      // AUTO-LIST SURPLUS FOR NGO
      // =======================================================

      if (surplusVal > 0) {

        const donorLocation =
          userData?.location ||
          {
            lat: 26.9124,
            lng: 75.7873
          };

        const donorName =
          userData?.name ||
          'My Hostel';

        const donorLocationName =
          userData?.address ||
          'Main Campus';


        // Create listing
        const listingRef = await addDoc(
          collection(db, 'listings'),
          {

            // -------------------------------------------------
            // ORDER / DONOR IDENTITY
            // -------------------------------------------------

            orderId: null,

            donorId: currentUser.uid,

            donorName,

            hostelId: currentUser.uid,

            hostelName: donorName,


            // -------------------------------------------------
            // FOOD DETAILS
            // -------------------------------------------------

            title: fullTitle,

            foodItem,

            mealType,

            category: detectedCategory,


            // -------------------------------------------------
            // QUANTITY / WEIGHT
            // -------------------------------------------------

            quantity: `${surplusVal}`,

            quantityValue: surplusVal,

            quantityUnit: unit,

            unit,

            quantityKg:
              unit === 'kg'
                ? surplusVal
                : null,

            remainingKg:
              unit === 'kg'
                ? surplusVal
                : null,

            freshnessMinutes:
              resolvedFreshnessMinutes,

            validityMinutes:
              resolvedFreshnessMinutes,

            freshnessSource,

            foodPreparedAt:
              foodPreparedAt ||
              preparedAt ||
              null,

            preparedAt:
              preparedAt ||
              foodPreparedAt ||
              null,

            remainingCapturedAt:
              remainingCapturedAt ||
              now.toISOString(),

            perishability:
              perishability ||
              null,


            // -------------------------------------------------
            // SOURCE
            // -------------------------------------------------

            source: 'legacy/manual',

            sourceLabel: 'Manual',


            // -------------------------------------------------
            // DONOR LOCATION
            // -------------------------------------------------

            location: donorLocation,

            locationName: donorLocationName,

            donorLocation,

            donorLocationName,


            // -------------------------------------------------
            // NGO DETAILS
            // Will be filled when NGO accepts order.
            // -------------------------------------------------

            ngoId: null,

            ngoName: null,

            ngoLocation: null,

            ngoLocationName: null,


            // -------------------------------------------------
            // ORDER STATUS
            // -------------------------------------------------

            status: 'Available',

            orderStatus: 'Available',

            priority,

            freshnessPriority:
              resolvedFreshnessMinutes <= 30
                ? 'Critical'
                : resolvedFreshnessMinutes <= 60
                  ? 'High'
                  : resolvedFreshnessMinutes <= 120
                    ? 'Medium'
                    : 'Low',

            etaMinutes: null,

            etaText: null,

            etaPriority: null,


            // -------------------------------------------------
            // EXPIRY
            // -------------------------------------------------

            expiryTime:
              calculatedExpiryTime.toISOString(),

            freshnessMinutes:
              resolvedFreshnessMinutes,

            validityMinutes:
              resolvedFreshnessMinutes,

            freshnessSource,

            foodPreparedAt:
              foodPreparedAt ||
              preparedAt ||
              null,

            preparedAt:
              preparedAt ||
              foodPreparedAt ||
              null,

            remainingCapturedAt:
              remainingCapturedAt ||
              now.toISOString(),

            perishability:
              perishability ||
              null,


            // -------------------------------------------------
            // TIMESTAMPS / LINK
            // -------------------------------------------------

            createdAt:
              serverTimestamp(),

            logId:
              logDocRef.id

          }
        );


        // Save the actual Firestore listing ID
        // as the order ID.
        await updateDoc(
          listingRef,
          {
            orderId: listingRef.id
          }
        );


        // Link food log with listing
        await updateDoc(
          doc(db, 'foodLogs', logDocRef.id),
          {
            status: 'listed-for-ngo',
            listingId: listingRef.id,
            listedAt: serverTimestamp()
          }
        );

      }


      return {
        surplus: surplusVal
      };

    },
    [currentUser, userData]
  );


  // =========================================================
  // UPDATE LOG STATUS
  // =========================================================

  const updateLogStatus = useCallback(
    async (logId, newStatus) => {

      if (!db) return;


      const logRef =
        doc(db, 'foodLogs', logId);


      await updateDoc(
        logRef,
        {
          status: newStatus
        }
      );

    },
    []
  );


  // =========================================================
  // CREATE LISTING FROM FOOD LOG
  // =========================================================

  const createListingFromLog = useCallback(
    async (log) => {

      if (!currentUser || !db) {
        throw new Error(
          'Not authenticated'
        );
      }


      const remainingKg = Number(
        log.remainingKg ??
        log.surplus ??
        0
      );


      if (remainingKg <= 0) {
        return null;
      }


      // Keep existing quantity-based priority for donor-side compatibility.
      const priority =
        remainingKg >= 20
          ? 'High'
          : remainingKg >= 10
            ? 'Medium'
            : 'Low';


      const now = new Date();

      const resolvedFreshness =
        resolveFoodExpiry(
          log,
          now
        );

      const expiryTime =
        resolvedFreshness.expiryTime;

      const resolvedFreshnessMinutes =
        resolvedFreshness.freshnessMinutes;

      const freshnessSource =
        resolvedFreshness.freshnessSource;


      const category =
        log.category ||
        detectCategoryFromTitle(
          log.title || ''
        );


      // Preserve the unit coming from Meal Entry.
      const unit =
        log.unit ||
        'kg';


      // =======================================================
      // DONOR INFORMATION
      // =======================================================

      const donorLocation =
        userData?.location ||
        {
          lat: 26.9124,
          lng: 75.7873
        };


      const donorName =
        userData?.name ||
        'My Hostel';


      const donorLocationName =
        userData?.address ||
        'Main Campus';


      // =======================================================
      // CREATE NGO ORDER / LISTING
      // =======================================================

      const listingRef = await addDoc(
        collection(db, 'listings'),
        {

          // ---------------------------------------------------
          // ORDER ID
          // ---------------------------------------------------

          orderId: null,


          // ---------------------------------------------------
          // DONOR DETAILS
          // ---------------------------------------------------

          donorId:
            currentUser.uid,

          donorName,

          hostelId:
            currentUser.uid,

          hostelName:
            donorName,


          // ---------------------------------------------------
          // FOOD DETAILS
          // ---------------------------------------------------

          title:
            log.title ||
            `${log.mealType || 'Meal'} - ${log.foodItem || 'Food'}`,

          foodItem:
            log.foodItem ||
            '',

          mealType:
            log.mealType ||
            '',

          category,


          // ---------------------------------------------------
          // QUANTITY / WEIGHT
          // ---------------------------------------------------

          quantity:
            `${remainingKg}`,

          quantityValue:
            remainingKg,

          quantityUnit:
            unit,

          unit,

          // If unit is kg, preserve the numeric weight.
          // Otherwise keep it null until a specific
          // conversion is available.

          quantityKg:
            unit === 'kg'
              ? remainingKg
              : null,

          remainingKg,

          // ---------------------------------------------------
          // FOOD FRESHNESS / EXPIRY
          // ---------------------------------------------------

          freshnessMinutes:
            resolvedFreshnessMinutes,

          validityMinutes:
            resolvedFreshnessMinutes,

          freshnessSource,

          foodPreparedAt:
            log.foodPreparedAt ||
            log.preparedAt ||
            null,

          preparedAt:
            log.preparedAt ||
            log.foodPreparedAt ||
            null,

          remainingCapturedAt:
            log.remainingCapturedAt ||
            null,

          perishability:
            log.perishability ||
            null,


          // ---------------------------------------------------
          // SOURCE
          // ---------------------------------------------------

          source:
            log.source ||
            'food-log',

          sourceLabel:
            log.sourceLabel ||
            'Food Log',


          // ---------------------------------------------------
          // DONOR LOCATION
          // ---------------------------------------------------

          location:
            donorLocation,

          locationName:
            donorLocationName,

          donorLocation,

          donorLocationName,


          // ---------------------------------------------------
          // NGO DETAILS
          // These are filled after an NGO accepts the order.
          // ---------------------------------------------------

          ngoId: null,

          ngoName: null,

          ngoLocation: null,

          ngoLocationName: null,


          // ---------------------------------------------------
          // ORDER STATUS
          // ---------------------------------------------------

          status:
            'Available',

          orderStatus:
            'Available',

          // Existing priority remains available
          // for the donor side.
          priority,

          // NGO priority is now determined from freshness / expiry.
          freshnessPriority:
            resolvedFreshnessMinutes <= 30
              ? 'Critical'
              : resolvedFreshnessMinutes <= 60
                ? 'High'
                : resolvedFreshnessMinutes <= 120
                  ? 'Medium'
                  : 'Low',

          // These fields will be calculated in the
          // NGO side after distance + ETA are available.

          etaMinutes: null,

          etaText: null,

          etaPriority: null,


          // ---------------------------------------------------
          // EXPIRY
          // ---------------------------------------------------

          expiryTime:
            expiryTime.toISOString(),


          // ---------------------------------------------------
          // TIMESTAMP
          // ---------------------------------------------------

          createdAt:
            serverTimestamp(),


          // ---------------------------------------------------
          // FOOD LOG LINK
          // ---------------------------------------------------

          logId:
            log.id

        }
      );


      // =======================================================
      // SAVE REAL ORDER ID
      // =======================================================

      await updateDoc(
        listingRef,
        {
          orderId: listingRef.id
        }
      );


      // =======================================================
      // MARK FOOD LOG AS LISTED
      // AND LINK IT TO THE ORDER
      // =======================================================

      const logRef =
        doc(db, 'foodLogs', log.id);


      await updateDoc(
        logRef,
        {
          status: 'listed-for-ngo',

          listingId:
            listingRef.id,

          listedAt:
            serverTimestamp(),

          expiryTime:
            expiryTime.toISOString(),

          freshnessMinutes:
            resolvedFreshnessMinutes,

          validityMinutes:
            resolvedFreshnessMinutes,

          freshnessSource
        }
      );


      // Return useful information for future screens.
      return {
        listingId: listingRef.id,
        orderId: listingRef.id,
        remainingKg
      };

    },
    [currentUser, userData]
  );


  // =========================================================
  // AI ACTIONS
  // =========================================================

  const addAction = useCallback(
    async (actionData) => {

      if (!currentUser || !db) {
        return null;
      }


      const docRef = await addDoc(
        collection(db, 'actions'),
        {

          hostelId:
            currentUser.uid,

          ...actionData,

          status:
            actionData.status ||
            'suggested',

          createdAt:
            serverTimestamp()

        }
      );


      return docRef.id;

    },
    [currentUser]
  );


  // =========================================================
  // UPDATE ACTION STATUS
  // =========================================================

  const updateActionStatus = useCallback(
    async (
      actionId,
      newStatus,
      extraUpdates = {}
    ) => {

      if (!db) return;


      const actionRef =
        doc(db, 'actions', actionId);


      await updateDoc(
        actionRef,
        {

          status:
            newStatus,

          updatedAt:
            serverTimestamp(),

          ...extraUpdates

        }
      );

    },
    []
  );


  // =========================================================
  // DELETE ACTION
  // =========================================================

  const deleteAction = useCallback(
    async (actionId) => {

      if (!db) return;


      const actionRef =
        doc(db, 'actions', actionId);


      await deleteDoc(
        actionRef
      );

    },
    []
  );


  // =========================================================
  // CONTEXT VALUE
  // =========================================================

  const value = {

    listings,

    logs,

    allLogs,

    actions,

    loading,

    kpis,

    rescueFunnel,

    impactTelemetry,

    impactTimeSeries,

    baseline7Days,

    addFoodLog,

    updateLogStatus,

    createListingFromLog,

    addAction,

    updateActionStatus,

    deleteAction

  };


  return (
    <HostelDataContext.Provider value={value}>
      {children}
    </HostelDataContext.Provider>
  );

};


export default HostelDataContext;