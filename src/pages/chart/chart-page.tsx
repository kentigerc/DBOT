import useMarketPanelHeight from '@/hooks/useMarketPanelHeight';
import ChartWrapper from './chart-wrapper';
import './chart.scss';

export default function ChartPage() {
    const panelRef = useMarketPanelHeight<HTMLDivElement>();
    return (
        <div className='market-chart-page' ref={panelRef}>
            <ChartWrapper show_digits_stats={false} />
        </div>
    );
}
