import { useEffect, useState } from 'react';
import useMarketPanelHeight from '@/hooks/useMarketPanelHeight';
import './deriv-charts.scss';

export default function DerivCharts({ active = true }: { active?: boolean }) {
    const [expanded, setExpanded] = useState(false);
    const panel = useMarketPanelHeight<HTMLDivElement>({
        enabled: active,
        fitToContainer: true,
        fullViewport: expanded,
    });
    const [version, setVersion] = useState(0);
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        if (!active) {
            setExpanded(false);
            return;
        }
        if (!expanded) return;
        const close = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setExpanded(false);
        };
        window.addEventListener('keydown', close);
        return () => window.removeEventListener('keydown', close);
    }, [active, expanded]);
    return (
        <div className={`deriv-charts-page${expanded ? ' deriv-charts-page--expanded' : ''}`} ref={panel}>
            <div className='deriv-charts-page__toolbar'>
                <span>Tradingview</span>
                <span className='deriv-charts-page__status' role='status'>
                    {loading ? 'Loading chart…' : ''}
                </span>
                <button type='button' aria-pressed={expanded} onClick={() => setExpanded(value => !value)}>
                    {expanded ? 'Exit expanded view' : 'Expand chart'}
                </button>
                <button
                    type='button'
                    onClick={() => {
                        setLoading(true);
                        setVersion(value => value + 1);
                    }}
                >
                    Reload chart
                </button>
            </div>
            <iframe
                key={version}
                title='Tradingview market analysis'
                src='https://charts.deriv.com/deriv'
                sandbox='allow-scripts allow-same-origin allow-forms allow-downloads'
                referrerPolicy='strict-origin-when-cross-origin'
                allowFullScreen
                onLoad={() => setLoading(false)}
            />
        </div>
    );
}
