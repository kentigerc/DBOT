import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

// First-party aggregate usage only: no URL queries, names, emails, account IDs or tokens.
export default function UsageTracker() {
    const location = useLocation();
    useEffect(() => {
        if (['/admin', '/callback'].includes(location.pathname)) return;
        const pages = [
            'dashboard',
            'bot_builder',
            'chart',
            'digit_analysis',
            'deriv_charts',
            'free_bots',
            'analysis_tool',
        ];
        const candidate =
            location.pathname === '/free-bots'
                ? 'free_bots'
                : location.pathname === '/analysis-tool'
                  ? 'analysis_tool'
                  : location.hash.slice(1);
        const tool = pages.includes(candidate) ? candidate : 'dashboard';
        const pulse = () => {
            if (document.visibilityState === 'hidden' || !navigator.onLine) return;
            void fetch('/api/analytics/pulse', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tool }),
            }).catch(() => {});
        };
        pulse();
        const interval = window.setInterval(pulse, 30000);
        document.addEventListener('visibilitychange', pulse);
        window.addEventListener('online', pulse);
        return () => {
            window.clearInterval(interval);
            document.removeEventListener('visibilitychange', pulse);
            window.removeEventListener('online', pulse);
        };
    }, [location.pathname, location.hash]);
    return null;
}
