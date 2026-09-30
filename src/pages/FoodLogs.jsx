import { useState, useMemo } from 'react';
import { useHostelData } from '../context/HostelDataContext';

const FoodLogs = () => {
  const {
    allLogs,
    loading,
    updateLogStatus,
    createListingFromLog
  } = useHostelData();

  const [searchTerm, setSearchTerm] = useState('');
  const [filterMeal, setFilterMeal] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [actionLoading, setActionLoading] = useState(null);
  const [actionMessage, setActionMessage] = useState('');

  const LOGS_PER_PAGE = 12;


  // =========================================================
  // GET ACTUAL FOOD REMAINING WEIGHT
  // =========================================================

  const getRemainingWeight = (log) => {

    // Direct remainingKg
    if (
      log?.remainingKg !== undefined &&
      log?.remainingKg !== null &&
      Number(log.remainingKg) >= 0
    ) {
      return Number(log.remainingKg);
    }


    // quantityKg fallback
    if (
      log?.quantityKg !== undefined &&
      log?.quantityKg !== null &&
      Number(log.quantityKg) >= 0
    ) {
      return Number(log.quantityKg);
    }


    // If a log contains multiple food items,
    // calculate total remaining weight.
    if (Array.isArray(log?.items)) {

      const totalRemaining = log.items.reduce(
        (total, item) =>
          total + Number(item?.remainingKg || 0),
        0
      );

      if (totalRemaining > 0) {
        return totalRemaining;
      }
    }


    // Legacy fallback
    return Number(log?.surplus || 0);
  };


  // =========================================================
  // GET UNIT
  // =========================================================

  const getWeightUnit = (log) => {

    if (
      log?.remainingKg !== undefined ||
      log?.quantityKg !== undefined ||
      Array.isArray(log?.items)
    ) {
      return 'kg';
    }

    return log?.unit || 'kg';
  };


  // =========================================================
  // FILTERED & PAGINATED LOGS
  // =========================================================

  const filteredLogs = useMemo(() => {

    return allLogs.filter(log => {

      const matchesSearch =
        log.title
          ?.toLowerCase()
          .includes(searchTerm.toLowerCase()) ||

        log.foodItem
          ?.toLowerCase()
          .includes(searchTerm.toLowerCase());


      const mealCategory =
        log.mealType ||
        log.title?.split(' - ')[0] ||
        '';


      const matchesMeal =
        filterMeal === 'all' ||
        mealCategory === filterMeal ||
        (
          filterMeal === 'Snack' &&
          mealCategory === 'Snacks'
        );


      const remainingWeight =
        getRemainingWeight(log);


      const matchesStatus =
        filterStatus === 'all' ||

        (
          filterStatus === 'surplus' &&
          remainingWeight > 0
        ) ||

        (
          filterStatus === 'zero-waste' &&
          remainingWeight === 0
        );


      return (
        matchesSearch &&
        matchesMeal &&
        matchesStatus
      );

    });

  }, [
    allLogs,
    searchTerm,
    filterMeal,
    filterStatus
  ]);


  const totalPages =
    Math.ceil(
      filteredLogs.length /
      LOGS_PER_PAGE
    );


  const paginatedLogs =
    filteredLogs.slice(
      (currentPage - 1) * LOGS_PER_PAGE,
      currentPage * LOGS_PER_PAGE
    );


  // =========================================================
  // SUMMARY STATS
  // =========================================================

  const stats = useMemo(() => {

    const total =
      allLogs.length;


    const surplusCount =
      allLogs.filter(
        log =>
          getRemainingWeight(log) > 0
      ).length;


    const zeroWaste =
      allLogs.filter(
        log =>
          getRemainingWeight(log) === 0
      ).length;


    const totalRemaining =
      allLogs.reduce(
        (acc, log) =>
          acc + getRemainingWeight(log),
        0
      );


    return {
      total,
      surplusCount,
      zeroWaste,
      totalRemaining
    };

  }, [allLogs]);


  // =========================================================
  // STORE
  // =========================================================

  const handleStore = async (log) => {

    setActionLoading(log.id);
    setActionMessage('');

    try {

      await updateLogStatus(
        log.id,
        'stored'
      );

      setActionMessage(
        `"${log.title}" marked as stored internally.`
      );

    } catch (err) {

      console.error(err);

      setActionMessage(
        'Failed to update. Please try again.'
      );

    }

    setActionLoading(null);

    setTimeout(
      () => setActionMessage(''),
      3000
    );
  };


  // =========================================================
  // LIST FOR NGO
  // =========================================================

  const handleListForNGO = async (log) => {

    setActionLoading(log.id);
    setActionMessage('');

    try {

      const remainingWeight =
        getRemainingWeight(log);


      if (remainingWeight <= 0) {

        setActionMessage(
          'No remaining food weight is available for NGO pickup.'
        );

        setActionLoading(null);

        setTimeout(
          () => setActionMessage(''),
          3000
        );

        return;
      }


      /*
       * IMPORTANT:
       *
       * The NGO listing should use FOOD REMAINING
       * as the parcel weight.
       *
       * We temporarily pass the remaining weight
       * as surplus because createListingFromLog()
       * uses the surplus field as its listing quantity.
       *
       * This keeps the existing Firestore flow intact
       * while making the parcel weight equal to
       * the actual Food Remaining weight.
       */

      const ngoLog = {
        ...log,

        surplus:
          remainingWeight,

        quantityKg:
          remainingWeight,

        remainingKg:
          remainingWeight,

        unit:
          'kg'
      };


      await createListingFromLog(
        ngoLog
      );


      setActionMessage(
        `"${log.foodItem || log.title}" listed for NGO pickup — ${remainingWeight.toFixed(3)} kg. 🚀`
      );

    } catch (err) {

      console.error(err);

      setActionMessage(
        'Failed to create NGO listing. Please try again.'
      );

    }


    setActionLoading(null);

    setTimeout(
      () => setActionMessage(''),
      3000
    );
  };


  // =========================================================
  // FORMAT DATE
  // =========================================================

  const formatDate = (timestamp) => {

    if (!timestamp) {
      return '—';
    }


    const date =
      timestamp.toDate
        ? timestamp.toDate()
        : new Date(timestamp);


    return date.toLocaleDateString(
      'en-IN',
      {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      }
    );
  };


  // =========================================================
  // STATUS BADGE
  // =========================================================

  const getStatusBadge = (log) => {

    if (
      log.status === 'picked-up'
    ) {

      return {
        text: 'Picked Up',
        class: 'badge-success'
      };

    }


    if (
      log.status === 'stored'
    ) {

      return {
        text: 'Stored',
        class: 'badge-stored'
      };

    }


    if (
      log.status === 'listed-for-ngo'
    ) {

      return {
        text: 'Listed for NGO',
        class: 'badge-listed'
      };

    }


    if (
      getRemainingWeight(log) > 0
    ) {

      return {
        text: 'Surplus',
        class: 'badge-warning'
      };

    }


    return {
      text: 'Zero Waste',
      class: 'badge-success'
    };
  };


  // =========================================================
  // SOURCE BADGE
  // =========================================================

  const getSourceBadge = (log) => {

    if (
      log.source === 'meal-entry' ||
      log.sourceLabel === 'Meal Entry'
    ) {

      return {
        text: '🍛 Meal Entry',
        class: 'logs-source-meal'
      };
    }


    return {
      text: 'Manual / Other',
      class: 'logs-source-other'
    };
  };


  // =========================================================
  // LOADING
  // =========================================================

  if (loading) {

    return (
      <div className="subpage-loading">

        <div className="loading-spinner"></div>

        <p>
          Loading logs...
        </p>

      </div>
    );
  }


  // =========================================================
  // PAGE
  // =========================================================

  return (

    <div className="subpage-container">


      {/* HEADER */}

      <div className="subpage-header">

        <div>

          <h1 className="subpage-title">
            Historical Food Logs
          </h1>

          <p className="subpage-subtitle">
            Complete history of all your meal entries
          </p>

        </div>

      </div>


      {/* =====================================================
          QUICK STATS
      ===================================================== */}

      <div className="logs-stats-bar">

        <div className="logs-stat">

          <span className="logs-stat-value">
            {stats.total}
          </span>

          <span className="logs-stat-label">
            Total Logs
          </span>

        </div>


        <div className="logs-stat">

          <span className="logs-stat-value logs-stat-warning">
            {stats.surplusCount}
          </span>

          <span className="logs-stat-label">
            With Remaining Food
          </span>

        </div>


        <div className="logs-stat">

          <span className="logs-stat-value logs-stat-success">
            {stats.zeroWaste}
          </span>

          <span className="logs-stat-label">
            Zero Waste
          </span>

        </div>


        <div className="logs-stat">

          <span className="logs-stat-value">

            {stats.totalRemaining.toFixed(3)}
            {' kg'}

          </span>

          <span className="logs-stat-label">
            Total Food Remaining
          </span>

        </div>

      </div>


      {/* =====================================================
          FILTERS
      ===================================================== */}

      <div className="logs-filters">

        <div className="logs-search-wrap">

          <span className="logs-search-icon">
            🔍
          </span>

          <input
            type="text"
            placeholder="Search by item name..."
            value={searchTerm}
            onChange={(e) => {

              setSearchTerm(
                e.target.value
              );

              setCurrentPage(1);

            }}
            className="logs-search-input"
            id="search-logs-input"
          />

        </div>


        <select
          value={filterMeal}
          onChange={(e) => {

            setFilterMeal(
              e.target.value
            );

            setCurrentPage(1);

          }}
          className="logs-filter-select"
          id="filter-meal-select"
        >

          <option value="all">
            All Meals
          </option>

          <option value="Breakfast">
            Breakfast
          </option>

          <option value="Lunch">
            Lunch
          </option>

          <option value="Evening Snacks">
            Evening Snacks
          </option>

          <option value="Snacks">
            Snacks
          </option>

          <option value="Dinner">
            Dinner
          </option>

        </select>


        <select
          value={filterStatus}
          onChange={(e) => {

            setFilterStatus(
              e.target.value
            );

            setCurrentPage(1);

          }}
          className="logs-filter-select"
          id="filter-status-select"
        >

          <option value="all">
            All Status
          </option>

          <option value="surplus">
            Remaining Food Only
          </option>

          <option value="zero-waste">
            Zero Waste Only
          </option>

        </select>

      </div>


      {/* =====================================================
          ACTION MESSAGE
      ===================================================== */}

      {actionMessage && (

        <div className="logs-action-toast">
          {actionMessage}
        </div>

      )}


      {/* =====================================================
          LOGS TABLE
      ===================================================== */}

      <div className="logs-table-container">

        <table
          className="logs-table"
          id="food-logs-table"
        >

          <thead>

            <tr>

              <th>
                Item
              </th>

              <th>
                Source
              </th>

              <th>
                Meal
              </th>

              <th>
                Date
              </th>

              <th>
                Prepared
              </th>

              <th>
                Consumed
              </th>

              <th>
                Remaining
              </th>

              <th>
                Status
              </th>

              <th>
                Actions
              </th>

            </tr>

          </thead>


          <tbody>

            {paginatedLogs.length > 0 ? (

              paginatedLogs.map(log => {

                const status =
                  getStatusBadge(log);

                const source =
                  getSourceBadge(log);

                const remainingWeight =
                  getRemainingWeight(log);

                const unit =
                  getWeightUnit(log);


                const canAct =
                  remainingWeight > 0 &&
                  (
                    !log.status ||
                    log.status === 'pending' ||
                    log.status === 'surplus'
                  );


                const isActing =
                  actionLoading === log.id;


                return (

                  <tr
                    key={log.id}
                    className="logs-table-row"
                  >


                    {/* ITEM */}

                    <td className="logs-td-item">

                      <span className="logs-item-name">

                        {log.foodItem ||
                          log.title ||
                          'Unnamed Item'}

                      </span>

                    </td>


                    {/* SOURCE */}

                    <td>

                      <span
                        className={`logs-source-badge ${source.class}`}
                      >
                        {source.text}
                      </span>

                    </td>


                    {/* MEAL */}

                    <td>

                      {log.mealType ||
                        log.title?.split(' - ')[0] ||
                        '—'}

                    </td>


                    {/* DATE */}

                    <td className="logs-td-date">

                      {formatDate(
                        log.createdAt
                      )}

                    </td>


                    {/* PREPARED */}

                    <td>

                      {log.prepared !== undefined
                        ? Number(log.prepared).toFixed(3)
                        : log.preparedKg !== undefined
                          ? Number(log.preparedKg).toFixed(3)
                          : '0.000'}

                      {' kg'}

                    </td>


                    {/* CONSUMED */}

                    <td>

                      {log.consumed !== undefined
                        ? Number(log.consumed).toFixed(3)
                        : log.consumedKg !== undefined
                          ? Number(log.consumedKg).toFixed(3)
                          : '0.000'}

                      {' kg'}

                    </td>


                    {/* =================================================
                        REMAINING
                    ================================================= */}

                    <td
                      className={
                        remainingWeight > 0
                          ? 'logs-td-surplus'
                          : ''
                      }
                    >

                      <strong>

                        {remainingWeight.toFixed(3)}

                      </strong>

                      {' kg'}

                    </td>


                    {/* STATUS */}

                    <td>

                      <span
                        className={`logs-badge ${status.class}`}
                      >

                        {status.text}

                      </span>

                    </td>


                    {/* ACTIONS */}

                    <td className="logs-td-actions">

                      {canAct ? (

                        <div className="logs-action-btns">


                          <button
                            className="logs-btn logs-btn-store"
                            onClick={() =>
                              handleStore(log)
                            }
                            disabled={isActing}
                            title="Store remaining food internally"
                          >

                            {isActing
                              ? '...'
                              : '📦 Store'}

                          </button>


                          <button
                            className="logs-btn logs-btn-ngo"
                            onClick={() =>
                              handleListForNGO(log)
                            }
                            disabled={isActing}
                            title="List remaining food for NGO pickup"
                          >

                            {isActing
                              ? '...'
                              : '🤝 List for NGO'}

                          </button>


                        </div>

                      ) : (

                        <span className="logs-action-done">
                          —
                        </span>

                      )}

                    </td>

                  </tr>

                );

              })

            ) : (

              <tr>

                <td
                  colSpan="9"
                  className="logs-empty"
                >

                  {allLogs.length === 0
                    ? 'No logs recorded yet.'
                    : 'No logs match your filters.'}

                </td>

              </tr>

            )}

          </tbody>

        </table>

      </div>


      {/* =====================================================
          PAGINATION
      ===================================================== */}

      {totalPages > 1 && (

        <div className="logs-pagination">


          <button
            className="logs-page-btn"
            disabled={
              currentPage === 1
            }
            onClick={() =>
              setCurrentPage(
                p => p - 1
              )
            }
          >
            ← Previous
          </button>


          <div className="logs-page-numbers">

            {Array.from(
              {
                length: totalPages
              },
              (_, i) => i + 1
            )
              .filter(
                p =>
                  p === 1 ||
                  p === totalPages ||
                  Math.abs(
                    p - currentPage
                  ) <= 1
              )
              .map(
                (p, idx, arr) => (

                  <span key={p}>

                    {idx > 0 &&
                      arr[idx - 1] !== p - 1 && (

                        <span className="logs-page-ellipsis">
                          ...
                        </span>

                      )}


                    <button
                      className={`logs-page-num ${
                        currentPage === p
                          ? 'active'
                          : ''
                      }`}
                      onClick={() =>
                        setCurrentPage(p)
                      }
                    >
                      {p}
                    </button>

                  </span>

                )
              )}

          </div>


          <button
            className="logs-page-btn"
            disabled={
              currentPage === totalPages
            }
            onClick={() =>
              setCurrentPage(
                p => p + 1
              )
            }
          >
            Next →
          </button>

        </div>

      )}

    </div>

  );
};


export default FoodLogs;