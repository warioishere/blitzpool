import { FindOperator, ValueTransformer } from 'typeorm';

const EUROPEAN_LOCALE_REGEX =
    /^(\d{1,2})\.(\d{1,2})\.(\d{4}),\s*(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(AM|PM))?$/i;
const US_LOCALE_REGEX =
    /^(\d{1,2})\/(\d{1,2})\/(\d{4}),\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i;

function parseLegacyLocaleString(value: string): Date | null {
    const trimmed = value.trim();

    const matchEuropean = trimmed.match(EUROPEAN_LOCALE_REGEX);
    if (matchEuropean) {
        const [, day, month, year, hours, minutes, seconds = '0', meridiem] = matchEuropean;
        return buildDateFromParts({
            year,
            month,
            day,
            hours,
            minutes,
            seconds,
            meridiem,
        });
    }

    const matchUs = trimmed.match(US_LOCALE_REGEX);
    if (matchUs) {
        const [, month, day, year, hours, minutes, seconds = '0', meridiem] = matchUs;
        return buildDateFromParts({
            year,
            month,
            day,
            hours,
            minutes,
            seconds,
            meridiem,
        });
    }

    return null;
}

function buildDateFromParts({
    year,
    month,
    day,
    hours,
    minutes,
    seconds,
    meridiem,
}: {
    year: string;
    month: string;
    day: string;
    hours: string;
    minutes: string;
    seconds: string;
    meridiem?: string;
}): Date {
    let hourValue = Number(hours);
    if (meridiem) {
        const normalized = meridiem.toUpperCase();
        if (normalized === 'PM' && hourValue < 12) {
            hourValue += 12;
        } else if (normalized === 'AM' && hourValue === 12) {
            hourValue = 0;
        }
    }

    return new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        hourValue,
        Number(minutes),
        Number(seconds),
    );
}

function normalizeDate(value: Date | string): Date {
    if (value instanceof Date) {
        return value;
    }

    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
        return date;
    }

    const legacyDate = parseLegacyLocaleString(value);
    if (legacyDate) {
        return legacyDate;
    }

    throw new Error(`Invalid date value received: ${value}`);
}

// TypeORM invokes `to` not only on insert/update values but also when
// building predicates from `where` criteria — including FindOperator
// wrappers (IsNull, Not, In, MoreThan, …). Those aren't Date/string and
// must pass through untouched, otherwise the transformer crashes on
// `value.trim()`.
function isTransformable(value: unknown): value is Date | string {
    return value instanceof Date || typeof value === 'string';
}

export class DateTimeTransformer implements ValueTransformer {
    to(value: Date | string | FindOperator<unknown> | null | undefined): Date | FindOperator<unknown> | null | undefined {
        if (value === null || value === undefined) {
            return value === undefined ? undefined : null;
        }
        if (!isTransformable(value)) {
            return value;
        }
        return normalizeDate(value);
    }

    from(value: Date | string | null | undefined): Date | null | undefined {
        if (value === null || value === undefined) {
            return value === undefined ? undefined : null;
        }
        if (!isTransformable(value)) {
            return value as unknown as Date;
        }
        return normalizeDate(value);
    }
}
