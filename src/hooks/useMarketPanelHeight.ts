import { useEffect, useRef } from 'react';
import '../styles/market-panel.scss';

let activePanels = 0;

// Keep market views between the actual header, tab bar and fixed trading controls.
export default function useMarketPanelHeight<T extends HTMLElement>() {
    const panelRef = useRef<T>(null);
    useEffect(() => {
        activePanels++;
        document.body.classList.add('market-panel-page');
        const measure = () => {
            const panel = panelRef.current;
            if (!panel) return;
            const top = panel.getBoundingClientRect().top;
            const viewport = window.visualViewport;
            let bottom = Math.min(
                window.innerHeight,
                viewport ? viewport.height + viewport.offsetTop : window.innerHeight
            );
            const selectors = ['.app-footer', '.controls__section'];
            if (window.matchMedia('(max-width: 1279px)').matches)
                selectors.push('.dc-drawer:not(.dc-drawer--open) .dc-drawer__toggle');
            for (const selector of selectors) {
                const element = document.querySelector(selector);
                const bounds = element?.getBoundingClientRect();
                if (bounds && bounds.height > 0 && bounds.top >= top) bottom = Math.min(bottom, bounds.top);
            }
            panel.style.setProperty('--market-panel-height', `${Math.max(0, bottom - top)}px`);
        };
        measure();
        const frame = requestAnimationFrame(measure);
        const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : undefined;
        for (const selector of ['.neto-header', '.main .dc-tabs__list', '.controls__section', '.app-footer']) {
            const element = document.querySelector(selector);
            if (element) observer?.observe(element);
        }
        window.addEventListener('resize', measure);
        window.visualViewport?.addEventListener('resize', measure);
        document.addEventListener('transitionend', measure);
        return () => {
            activePanels--;
            if (!activePanels) document.body.classList.remove('market-panel-page');
            cancelAnimationFrame(frame);
            observer?.disconnect();
            window.removeEventListener('resize', measure);
            window.visualViewport?.removeEventListener('resize', measure);
            document.removeEventListener('transitionend', measure);
        };
    }, []);
    return panelRef;
}
