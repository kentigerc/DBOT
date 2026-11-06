// Quote every cell and neutralize spreadsheet formulas before CSV serialization.
// Real numeric values retain their sign and remain usable for financial analysis.
export function csvCell(value: unknown): string {
    let text = value === null || value === undefined ? '' : String(value);
    const numeric = typeof value === 'number' && Number.isFinite(value);
    if (!numeric && (/^[\s\u0000-\u001f\u007f-\u009f]*[=+\-@]/u.test(text) || /^[\t\r\n]/.test(text)))
        text = "'" + text;
    return `"${text.replace(/"/g, '""')}"`;
}
export function csvRows(rows: readonly (readonly unknown[])[]): string {
    return rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}
