import { useState } from 'react';
import useMarketPanelHeight from '@/hooks/useMarketPanelHeight';
import './deriv-charts.scss';

export default function DerivCharts() {
    const panel = useMarketPanelHeight<HTMLDivElement>();
    const [version, setVersion] = useState(0);
    const [loading, setLoading] = useState(true);
    return (
        <div className='deriv-charts-page' ref={panel}>
            <div className='deriv-charts-page__toolbar'>
                <span>Deriv Charts</span>
                <span className='deriv-charts-page__status' role='status'>
                    {loading ? 'Loading chart…' : ''}
                </span>
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
                title='Deriv Charts market analysis'
                src='https://charts.deriv.com/deriv'
                sandbox='allow-scripts allow-same-origin allow-forms allow-downloads'
                referrerPolicy='strict-origin-when-cross-origin'
                allowFullScreen
                onLoad={() => setLoading(false)}
            />
            <p className='deriv-charts-page__notice'>
                Charts are provided by Deriv. If the chart stays blank, try Reload chart.
            </p>
        </div>
    );
}
