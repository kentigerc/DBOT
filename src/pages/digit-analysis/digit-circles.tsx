import { digitFrequencies } from './digits';

export default function DigitCircles({ digits }: { digits: number[] }) {
    const frequencies = digitFrequencies(digits);
    const highest = Math.max(...frequencies.map(item => item.count));
    const lowest = Math.min(...frequencies.map(item => item.count));
    const latestDigit = digits.at(-1);
    return (
        <>
            <div className='digit-analysis__grid' aria-label='Last-digit frequencies'>
                {frequencies.map((item, digit) => {
                    const high = digits.length > 0 && highest !== lowest && item.count === highest;
                    const low = digits.length > 0 && highest !== lowest && item.count === lowest;
                    return (
                        <div
                            key={digit}
                            className={`digit-analysis__digit${high ? ' digit-analysis__digit--high' : ''}${low ? ' digit-analysis__digit--low' : ''}${latestDigit === digit ? ' digit-analysis__digit--latest' : ''}`}
                        >
                            <div
                                className='digit-analysis__circle'
                                aria-label={`Digit ${digit}: ${item.percent.toFixed(1)} percent, ${item.count} ticks`}
                            >
                                <strong>{digit}</strong>
                                <span>{item.percent.toFixed(1)}%</span>
                            </div>
                            <span className='digit-analysis__count'>{item.count} ticks</span>
                            <span className='digit-analysis__marker'>
                                {latestDigit === digit
                                    ? 'Latest digit'
                                    : high
                                      ? 'Most frequent'
                                      : low
                                        ? 'Least frequent'
                                        : '\u00a0'}
                            </span>
                        </div>
                    );
                })}
            </div>
            <div className='digit-analysis__legend'>
                <span>
                    <i className='digit-analysis__key digit-analysis__key--high' />
                    Most frequent
                </span>
                <span>
                    <i className='digit-analysis__key digit-analysis__key--low' />
                    Least frequent
                </span>
                <span>
                    <i className='digit-analysis__key' />
                    Latest digit
                </span>
            </div>
        </>
    );
}
