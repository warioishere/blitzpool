import { ValueTransformer } from 'typeorm';

function normalizeDate(value: Date | string): Date {
    if (value instanceof Date) {
        return value;
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw new Error(`Invalid date value received: ${value}`);
    }
    return date;
}

export class DateTimeTransformer implements ValueTransformer {
    to(value: Date | string | null | undefined): Date | null | undefined {
        if (value === null || value === undefined) {
            return value === undefined ? undefined : null;
        }

        return normalizeDate(value);
    }

    from(value: Date | string | null | undefined): Date | null | undefined {
        if (value === null || value === undefined) {
            return value === undefined ? undefined : null;
        }

        return normalizeDate(value);
    }
}
