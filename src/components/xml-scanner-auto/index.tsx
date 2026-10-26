import { useEffect, useSyncExternalStore } from 'react';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import { getDerivAccount } from '@/utils/deriv-session';
import { xmlScannerCycle } from '@/utils/xml-scanner-cycle';

const XmlScannerAuto = observer(() => {
    const { run_panel } = useStore();
    const state = useSyncExternalStore(xmlScannerCycle.subscribe, xmlScannerCycle.getSnapshot);
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
    // Keep runner lifecycle/account/offline guards mounted without a floating panel.
    return null;
});
export default XmlScannerAuto;
