import type { CSSProperties } from 'react';

const streams = Array.from({ length: 28 }, (_, index) => ({
    style: {
        '--x': `${(index * 100) / 28}%`,
        '--duration': `${12 + (index % 7) * 2}s`,
        '--delay': `${-index * 2.7}s`,
        '--opacity': 0.25 + (index % 5) * 0.15,
    } as CSSProperties,
    text: (index % 2 ? '10110010100011010110' : '01001101011010010001').repeat(5),
}));

export default function ChunkLoader({ message }: { message: string }) {
    return (
        <div className='neto-welcome' role='status' aria-live='polite'>
            <div className='neto-welcome__rain' aria-hidden='true'>
                {streams.map((stream, index) => (
                    <span key={index} className='neto-welcome__stream' style={stream.style}>
                        {stream.text}
                    </span>
                ))}
            </div>
            <div className='neto-welcome__panel'>
                <p className='neto-welcome__eyebrow'>NETOACADEMY</p>
                <h1 className='neto-welcome__title'>
                    Welcome To <span>NetoAcademy</span>
                </h1>
                <p className='neto-welcome__message'>Trade Responsibly</p>
                <div className='neto-welcome__status'>
                    <span className='neto-welcome__dot' aria-hidden='true' />
                    <span>{message}</span>
                </div>
            </div>
        </div>
    );
}
