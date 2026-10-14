/**
 * registrationWindow.js
 *
 * Shared helper for computing whether an academic program's registration
 * window is open RIGHT NOW, based on Manila wall-clock time.
 *
 * ── MODEL ────────────────────────────────────────────────────────────────
 * Each academic program now has TWO independent controls:
 *
 *   1. `manual_enabled` (0/1) — the admin's master switch. This is what
 *      the toggle in the admin UI controls. It is ALWAYS live and ALWAYS
 *      interactive, whether or not a schedule is set.
 *
 *   2. `start_date` / `end_date` (optional daily hours window) — when set,
 *      the program can only be open during that daily window (wrapping
 *      past midnight if needed, e.g. 18:00 -> 06:00), evaluated in Manila
 *      time, but ONLY while `manual_enabled` is also on.
 *
 * Combined truth table:
 *   manual_enabled = 0                         -> always CLOSED
 *   manual_enabled = 1, no schedule             -> always OPEN
 *   manual_enabled = 1, schedule set             -> OPEN only inside the
 *                                                    daily hour window,
 *                                                    auto-flips at the
 *                                                    exact minute/second
 *
 * `open` is a DERIVED/cached field — the live computed result of the rule
 * above — kept in sync by syncProgramsOpenStatus/syncBranchesOpenStatus so
 * other code (branch-derived open status, the applicant dropdown) can read
 * it cheaply without recomputing. It is never the source of truth itself.
 *
 * A branch has no independent season of its own — a branch is open
 * whenever ANY of its academic programs is currently open.
 */

/**
 * Returns the current Manila date/time as a plain Date object whose
 * getHours()/getMinutes()/getFullYear()/etc. all reflect Manila wall-clock
 * values, regardless of what timezone the server itself is running in.
 */
const getNowInManila = () => {
  const nowManilaStr = new Date().toLocaleString("en-US", {
    timeZone: "Asia/Manila",
    hour12: false,
  });
  return new Date(nowManilaStr);
};

/**
 * Computes whether a single academic program should be considered "open"
 * right now.
 *
 * @param {object} entity - academic-program object. Reads `manual_enabled`
 *   (falls back to legacy `open` field if `manual_enabled` has never been
 *   set, so existing saved data keeps working after this upgrade) plus
 *   optional start_date/end_date ("YYYY-MM-DDTHH:mm" strings).
 * @param {Date} [now] - optional override for "current time" (mainly for testing)
 * @param {string} [flagKey] - unused for the manual-enable check now, kept
 *   for call-site compatibility with existing callers.
 * @param {object} [opts]
 * @param {boolean} [opts.dailyWindow=true] - whether to enforce the hour-of-day
 *   portion of start_date/end_date in addition to the date range.
 * @returns {boolean} whether the entity is currently open
 */
const computeIsOpen = (
  entity,
  now = getNowInManila(),
  flagKey = "open",
  { dailyWindow = true } = {},
) => {
  const hasSchedule = !!(entity.start_date && entity.end_date);

  // ── NO SCHEDULE: pure manual mode. The switch is the only thing that
  //    matters here — this is the on/off toggle case. ────────────────────
  if (!hasSchedule) {
    const manualEnabled =
      entity.manual_enabled !== undefined && entity.manual_enabled !== null
        ? Number(entity.manual_enabled) === 1
        : Number(entity[flagKey]) === 1;
    return manualEnabled;
  }

  // ── SCHEDULE SET: fully automatic. The manual switch is NOT consulted
  //    at all once Start/End are filled in — the date/time window alone
  //    decides open vs closed, flipping on its own at the exact moment.
  //    No toggle needed; setting the schedule IS turning it on. ──────────
  const [startDatePart, startTimePart] = entity.start_date.split("T");
  const [endDatePart, endTimePart] = entity.end_date.split("T");

  // Build date-only values with (year, month, day) args, not a bare
  // "YYYY-MM-DD" string — a bare ISO date string parses as UTC midnight,
  // not local midnight, which would silently shift the range comparison
  // hours off from the actual Manila wall-clock date.
  const todayDateOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const [startYear, startMonthNum, startDay] = startDatePart.split("-").map(Number);
  const startDateOnly = new Date(startYear, startMonthNum - 1, startDay);

  const [endYear, endMonthNum, endDay] = endDatePart.split("-").map(Number);
  const endDateOnly = new Date(endYear, endMonthNum - 1, endDay);

  const withinDateRange = todayDateOnly >= startDateOnly && todayDateOnly <= endDateOnly;

  // ── DATE-RANGE-ONLY CHECK: kept for backward compatibility. ────────────
  if (!dailyWindow) {
    return withinDateRange;
  }

  // Guard against malformed/legacy data that has a date but no "T" time part.
  if (!startTimePart || !endTimePart) {
    return withinDateRange;
  }

  const [startHour, startMinute] = startTimePart.split(":").map(Number);
  const [endHour, endMinute] = endTimePart.split(":").map(Number);

  let isOpen;

  if (!withinDateRange) {
    isOpen = false;
  } else {
    // Compare at SECOND-level granularity, not minute-level.
    const nowTotal = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    const startTotal = startHour * 3600 + startMinute * 60;
    const endTotal = endHour * 3600 + endMinute * 60;

    if (startTotal < endTotal) {
      // Normal same-day window, e.g. 6:00 -> 18:00 (Graduate)
      isOpen = nowTotal >= startTotal && nowTotal < endTotal;
    } else if (startTotal > endTotal) {
      // Cross-midnight window, e.g. 18:00 -> 6:00 (Undergraduate)
      isOpen = nowTotal >= startTotal || nowTotal < endTotal;
    } else {
      // start === end: treated as "open all day" within the date range
      isOpen = true;
    }
  }

  // Hard stop: once today's date is past the end date entirely, force closed.
  if (todayDateOnly > endDateOnly) {
    isOpen = false;
  }

  return isOpen;
};
/**
 * Given one branch's academicPrograms array, returns a NEW array where
 * every program's `open` flag (the cached/derived display value) has been
 * recomputed live from computeIsOpen — for EVERY program, not just
 * scheduled ones, since `open` now always mirrors the manual_enabled +
 * schedule rule regardless of which mode the program is in.
 *
 * @param {Array} academicPrograms
 * @param {Date} now
 * @returns {{ programs: Array, changed: boolean }}
 */
const syncProgramsOpenStatus = (academicPrograms, now = getNowInManila()) => {
  if (!Array.isArray(academicPrograms)) {
    return { programs: academicPrograms, changed: false };
  }

  let changed = false;

  const updated = academicPrograms.map((prog) => {
    const liveIsOpen = computeIsOpen(prog, now, "open") ? 1 : 0;
    const storedIsOpen = Number(prog.open) === 1 ? 1 : 0;

    if (liveIsOpen !== storedIsOpen) {
      changed = true;
      return { ...prog, open: liveIsOpen };
    }
    return prog;
  });

  return { programs: updated, changed };
};

/**
 * Given the full branches array, returns a NEW array where every branch's
 * academicPrograms[].open have been recomputed live, and each branch's
 * registration_open flag has been DERIVED from those programs (open if
 * ANY academic program under that branch is currently open).
 *
 * @param {Array} branches
 * @returns {{ branches: Array, changed: boolean }}
 */
const syncBranchesOpenStatus = (branches) => {
  const now = getNowInManila();
  let changed = false;

  const updated = branches.map((b) => {
    let nextBranch = b;

    const { programs, changed: programsChanged } = syncProgramsOpenStatus(
      nextBranch.academicPrograms,
      now
    );
    if (programsChanged) {
      changed = true;
      nextBranch = { ...nextBranch, academicPrograms: programs };
    }

    const anyProgramOpen = (nextBranch.academicPrograms || []).some(
      (p) => Number(p.open) === 1
    );
    const derivedOpen = anyProgramOpen ? 1 : 0;
    const storedOpen = Number(nextBranch.registration_open) === 1 ? 1 : 0;

    if (derivedOpen !== storedOpen) {
      changed = true;
      nextBranch = { ...nextBranch, registration_open: derivedOpen };
    }

    return nextBranch;
  });

  return { branches: updated, changed };
};

module.exports = {
  getNowInManila,
  computeIsOpen,
  syncProgramsOpenStatus,
  syncBranchesOpenStatus,
};