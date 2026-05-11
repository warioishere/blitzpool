import { SLOT_DURATION_MS } from '../constants/mining.constants';

/**
 * Safety buffer between slot-end and the moment a chart will display that
 * slot. A slot ending at X is hidden until `now > X + CHART_VISIBILITY_BUFFER_MS`.
 *
 * Rationale: any flush mechanism (Redis-flush-on-slot-transition, or in-memory
 * per-minute partial flush + slot-boundary flush) has a non-zero window
 * between "slot ended" and "slot fully persisted to PG". If the chart reads
 * during that window it can show a partial datapoint, which has bitten the
 * operator before. 60 s is generous against every realistic flush cadence
 * we run, and the operator explicitly accepts the 1-minute display delay
 * in exchange for guaranteed completeness.
 */
export const CHART_VISIBILITY_BUFFER_MS = 60_000;

/**
 * Time Slot Helper
 * Centralized time slot calculation logic to ensure consistency across the codebase
 *
 * Time slots are 10-minute windows labeled by their END time.
 * Example: Slot "08:50" contains data from 08:40:00 to 08:49:59
 */
export class TimeSlotHelper {
  /**
   * Get the current time slot (labeled by END time)
   *
   * @returns Timestamp of the current slot's end time
   *
   * @example
   * // Current time: 2024-01-01 08:43:27
   * getCurrentSlot() // Returns timestamp for 2024-01-01 08:50:00
   */
  static getCurrentSlot(): number {
    const now = Date.now();
    return Math.floor(now / SLOT_DURATION_MS) * SLOT_DURATION_MS + SLOT_DURATION_MS;
  }

  /**
   * Get the *chart-visible* cutoff slot — the slot containing
   * `now - CHART_VISIBILITY_BUFFER_MS`. Used by chart endpoints in a
   * `WHERE time < cutoff` filter so the latest visible slot is guaranteed
   * to be fully persisted to PG (no rising datapoints).
   *
   * At slot end (X) the cutoff still points BEFORE that slot, hiding it.
   * Once `now >= X + CHART_VISIBILITY_BUFFER_MS` the cutoff moves past X
   * and the slot becomes visible — by which point any flush mechanism
   * has had at least `CHART_VISIBILITY_BUFFER_MS` to commit the slot's
   * data to PG.
   *
   * @example
   * // Current time: 2024-01-01 10:00:30, buffer = 60s
   * // cutoff time = 09:59:30 → its slot ends at 10:00:00
   * getChartVisibilityCutoffSlot() // 10:00:00
   * // → chart filter `time < 10:00:00` hides slot 10:00 until 10:01:00
   */
  static getChartVisibilityCutoffSlot(): number {
    const cutoff = Date.now() - CHART_VISIBILITY_BUFFER_MS;
    return Math.floor(cutoff / SLOT_DURATION_MS) * SLOT_DURATION_MS + SLOT_DURATION_MS;
  }

  /**
   * Get a specific time slot for a given timestamp
   *
   * @param timestamp - Timestamp in milliseconds
   * @returns Time slot (end time) for the given timestamp
   *
   * @example
   * // timestamp: 2024-01-01 08:43:27
   * getSlotForTime(timestamp) // Returns timestamp for 2024-01-01 08:50:00
   */
  static getSlotForTime(timestamp: number): number {
    return Math.floor(timestamp / SLOT_DURATION_MS) * SLOT_DURATION_MS + SLOT_DURATION_MS;
  }

  /**
   * Check if a time slot is complete (not the current incomplete slot)
   *
   * @param slot - Time slot timestamp to check
   * @returns true if the slot is complete and can be flushed to database
   *
   * @example
   * // Current time: 08:43, current slot: 08:50
   * isSlotComplete(slot_08_40) // true - old slot, complete
   * isSlotComplete(slot_08_50) // false - current slot, incomplete
   */
  static isSlotComplete(slot: number): boolean {
    return slot < this.getCurrentSlot();
  }

  /**
   * Check if a time slot is the current (incomplete) slot
   *
   * @param slot - Time slot timestamp to check
   * @returns true if this is the current incomplete slot
   */
  static isCurrentSlot(slot: number): boolean {
    return slot === this.getCurrentSlot();
  }

  /**
   * Get the previous time slot (10 minutes before current)
   *
   * @returns Timestamp of the previous slot's end time
   */
  static getPreviousSlot(): number {
    return this.getCurrentSlot() - SLOT_DURATION_MS;
  }

  /**
   * Format a time slot timestamp to ISO string
   *
   * @param slot - Time slot timestamp
   * @returns ISO string representation
   */
  static formatSlot(slot: number): string {
    return new Date(slot).toISOString();
  }
}
