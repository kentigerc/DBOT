// Format to the market's quoted precision so a price such as 123.40 contributes digit 0.
export function lastDigit(quote: number | string, precision: number): number | null {
    if (
        quote === '' ||
        !Number.isFinite(Number(quote)) ||
        !Number.isInteger(precision) ||
        precision < 0 ||
        precision > 10
    )
        return null;
    const formatted = Number(quote).toFixed(precision);
    const digit = Number(formatted.at(-1));
    return Number.isInteger(digit) ? digit : null;
}

export function digitFrequencies(digits: number[]) {
    const counts = Array<number>(10).fill(0);
    for (const digit of digits) if (Number.isInteger(digit) && digit >= 0 && digit <= 9) counts[digit]++;
    const total = counts.reduce((sum, count) => sum + count, 0);
    return counts.map(count => ({ count, percent: total ? (count / total) * 100 : 0 }));
}
