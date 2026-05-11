/**
 * Time slot utility functions
 *
 * Provides helpers for working with 10-minute time slots that use end-time labeling.
 *
 * Time slot labeling convention:
 * - Slot labeled "20:50" contains data from 20:40:00 to 20:49:59
 * - This is "end-time labeling" (slot label = end of collection period)
 */

/**
 * Generate array of complete time slot timestamps
 *
 * Returns only slots that are complete AND fully persisted to PG. The
 * just-ended slot stays hidden for `CHART_VISIBILITY_BUFFER_MS` after it
 * ended (default 60 s) so the chart never shows a rising/partial datapoint
 * while the coordinator is still committing the slot's residual to PG.
 * All slots use end-time labeling (e.g. slot 20:50 = data from 20:40-20:50).
 *
 * @param sinceTime - Start of time range (milliseconds since epoch)
 * @param now - Current time (milliseconds since epoch)
 * @param slotDurationMs - Duration of each time slot in milliseconds (default: 10 minutes)
 * @returns Array of time slot timestamps (milliseconds since epoch)
 *
 * @example
 * // At 20:45, get slots for last 24 hours
 * const now = Date.now(); // 20:45
 * const yesterday = now - 24 * 60 * 60 * 1000;
 * const slots = generateCompleteTimeSlots(yesterday, now);
 * // Returns: [..., 20:10, 20:20, 20:30]
 * // Slot 20:40 hidden until 20:51 (60 s after its 20:50 end? — wait,
 * //   20:40-end is 20:40 itself in end-time labelling; visible at 20:41).
 * // 20:50 (current) is hidden anyway.
 */
import { CHART_VISIBILITY_BUFFER_MS } from './time-slot.helper';

export function generateCompleteTimeSlots(
  sinceTime: number,
  now: number,
  slotDurationMs: number = 10 * 60 * 1000, // 10 minutes default
): number[] {
  // Shift `now` back by the visibility buffer so the slot that ended in the
  // last `CHART_VISIBILITY_BUFFER_MS` is treated as not-yet-visible. This
  // matches the chart-side filter in TimeSlotHelper.getChartVisibilityCutoffSlot().
  const visibleNow = now - CHART_VISIBILITY_BUFFER_MS;

  // Calculate cutoff slot (end-time labeled). Slots with end-time < cutoff
  // are eligible for display.
  const currentSlot = Math.floor(visibleNow / slotDurationMs) * slotDurationMs + slotDurationMs;

  // Calculate first complete slot in range (end-time labeled)
  const startSlot = Math.floor(sinceTime / slotDurationMs) * slotDurationMs + slotDurationMs;

  // Generate array of complete slots
  const slots: number[] = [];
  for (let t = startSlot; t < currentSlot; t += slotDurationMs) {
    slots.push(t);
  }

  return slots;
}

/**
 * Format time slot timestamp as ISO string
 *
 * @param timestamp - Time slot timestamp (milliseconds since epoch)
 * @returns ISO 8601 formatted string
 *
 * @example
 * formatTimeSlot(1735156800000) // "2025-12-25T20:50:00.000Z"
 */
export function formatTimeSlot(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

/**
 * Generate time slot data array with formatted timestamps
 *
 * Helper that combines generateCompleteTimeSlots and formatTimeSlot.
 * Maps slot timestamps to objects with ISO-formatted time strings.
 *
 * @param sinceTime - Start of time range (milliseconds since epoch)
 * @param now - Current time (milliseconds since epoch)
 * @param mapFn - Function to map each slot timestamp to data
 * @param slotDurationMs - Duration of each time slot in milliseconds (default: 10 minutes)
 * @returns Array of slot data with formatted time strings
 *
 * @example
 * const slotData = generateFormattedTimeSlots(
 *   yesterday,
 *   now,
 *   (t) => ({ counts: { accepted: slotMap.get(t) || 0 } })
 * );
 * // Returns: [
 * //   { time: "2025-12-25T20:10:00.000Z", counts: { accepted: 42 } },
 * //   { time: "2025-12-25T20:20:00.000Z", counts: { accepted: 38 } },
 * //   ...
 * // ]
 */
export function generateFormattedTimeSlots<T>(
  sinceTime: number,
  now: number,
  mapFn: (timestamp: number) => T,
  slotDurationMs: number = 10 * 60 * 1000,
): Array<{ time: string } & T> {
  const slots = generateCompleteTimeSlots(sinceTime, now, slotDurationMs);

  return slots.map(timestamp => ({
    time: formatTimeSlot(timestamp),
    ...mapFn(timestamp),
  }));
}
