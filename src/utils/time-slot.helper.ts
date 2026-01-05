import { SLOT_DURATION_MS } from '../constants/mining.constants';

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
