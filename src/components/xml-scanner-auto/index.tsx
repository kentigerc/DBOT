import { useEffect, useState, useSyncExternalStore } from 'react';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import { getDerivAccount } from '@/utils/deriv-session';
import { xmlScannerCycle } from '@/utils/xml-scanner-cycle';
import useMovablePanel from '../movable-panel/use-movable-panel';
import './xml-scanner-auto.scss';

const XmlScannerAuto = observer(() => {
    const { run_panel } = useStore();
    const state = useSyncExternalStore(xmlScannerCycle.subscribe, xmlScannerCycle.getSnapshot);
    const movable = useMovablePanel('XML Auto status');
    const [dismissed, setDismissed] = useState(-1);
    const running = run_panel.is_running,
        open = run_panel.has_open_contract;
    useEffect(() => {
        if (!running && !open) xmlScannerCycle.runnerStopped();
    }, [running, open, state.phase]);
    useEffect(() => {
        const account = () => {
            const current = xmlScannerCycle.getSnapshot();
            if (current.enabled && getDerivAccount()?.account_id !== current.accountId)
                xmlScannerCycle.stop('Deriv account changed. Start XML Auto again on the selected account.');
        };
        const offline = () => xmlScannerCycle.stop('Connection lost. XML Auto stopped; check any open contract.');
        window.addEventListener('neto-session', account);
        window.addEventListener('storage', account);
        window.addEventListener('offline', offline);
        return () => {
            window.removeEventListener('neto-session', account);
            window.removeEventListener('storage', account);
            window.removeEventListener('offline', offline);
            xmlScannerCycle.stop('Trading page closed.');
        };
    }, []);
    if (state.phase === 'idle' || (!state.enabled && dismissed === state.generation)) return null;
    return (
        <aside
            className='xml-scanner-auto'
            ref={movable.ref}
            style={{ ...movable.style, zIndex: 11990 }}
            aria-label='XML Auto status'
        >
            {movable.handle}
            <span>XML Auto</span>
            <strong>{state.match ? `${state.match.name} · ${state.match.symbol}` : 'Scanning Over / Under'}</strong>
            <p role='status'>{state.message}</p>
            <p>
                Wins {state.wins}/3 · Batches {state.batches} · P/L {(state.pnl / 100).toFixed(2)}
            </p>
            <button disabled={!state.enabled} onClick={() => xmlScannerCycle.stop()}>
                STOP XML AUTO
            </button>
            {!state.enabled && <button onClick={() => setDismissed(state.generation)}>Close</button>}
        </aside>
    );
});
export default XmlScannerAuto;
