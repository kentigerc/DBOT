import { csvCell, csvRows } from '../csv';
describe('spreadsheet-safe CSV exports', () => {
    it.each([
        '=1+1',
        '+SUM(1,2)',
        '-1+2',
        '@SUM(A1:A2)',
        '\t=CMD()',
        '\r=CMD()',
        '\n=CMD()',
        '  =CMD()',
        '\u0000=CMD()',
        '\ufeff=CMD()',
    ])('neutralizes formula text %j', value => {
        expect(csvCell(value)).toBe(`"'${value}"`);
    });
    it('preserves numeric loss values and ordinary trade fields', () => {
        expect(
            csvRows([
                ['Contract', 'P/L'],
                [12345, -0.35],
            ])
        ).toBe('"Contract","P/L"\r\n"12345","-0.35"');
        expect(csvCell(null)).toBe('""');
    });
    it('escapes delimiters, quotes and line breaks inside cells', () => {
        expect(csvRows([['market,name', 'say "hi"', 'first\r\nsecond']])).toBe(
            '"market,name","say ""hi""","first\r\nsecond"'
        );
    });
});
