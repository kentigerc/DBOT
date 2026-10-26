import { useEffect, useState, useSyncExternalStore } from 'react';
import { observer } from 'mobx-react-lite';
import { generateDerivApiInstance } from '@/external/bot-skeleton/services/api/appId';
import { useStore } from '@/hooks/useStore';
import { lastDigit } from '@/pages/digit-analysis/digits';
import { evaluateScan } from '@/pages/digit-analysis/scanner';
import { risingScannerDigits, scannerExitGuard } from '@/utils/scanner-exit-guard';
import { getScannerWatch, setScannerWatch, subscribeScannerWatch } from '@/utils/scanner-watch';
import { xmlScannerCycle } from '@/utils/xml-scanner-cycle';
import useMovablePanel from '../movable-panel/use-movable-panel';
import './scanner-trade-monitor.scss';

type Tick = { quote: number; epoch: number; pip_size: number; symbol?: string; underlying_symbol?: string };
const ScannerTradeMonitor = observer(() => {
    const { run_panel } = useStore();
    const movable = useMovablePanel('market monitor');
    const target = useSyncExternalStore(subscribeScannerWatch, getScannerWatch);
    const running = run_panel.is_running;
    const protection = useSyncExternalStore(scannerExitGuard.subscribe, scannerExitGuard.getSnapshot);
    const workspaceName = (window as unknown as { Blockly?: { xmlValues?: { file_name?: string } } }).Blockly?.xmlValues
        ?.file_name;
    const [issue, setIssue] = useState('');
    const [workspaceSymbol, setWorkspaceSymbol] = useState('');
    const [checkedAt, setCheckedAt] = useState('');
    useEffect(() => {
        if (!running) {
            setWorkspaceSymbol('');
            return;
        }
        const workspace = (
            window as unknown as {
                Blockly?: {
                    derivWorkspace?: {
                        getAllBlocks: () => {
                            type: string;
                            data?: string;
                            getFieldValue: (name: string) => string | null;
                        }[];
                        addChangeListener: (listener: () => void) => void;
                        removeChangeListener: (listener: () => void) => void;
                    };
                };
            }
        ).Blockly?.derivWorkspace;
        const read = () => {
            const blocks = workspace?.getAllBlocks() || [];
            const symbol =
                blocks.find(block => block.type === 'trade_definition_market')?.getFieldValue('SYMBOL_LIST') || '';
            setWorkspaceSymbol(symbol);
            const sources = blocks.map(block => block.data);
            const over = sources.includes('netoacademy:hosted-bot:over-punisher.xml');
            const under = sources.includes('netoacademy:hosted-bot:under-punisher.xml');
            const side = over && !under ? 'over' : under && !over ? 'under' : undefined;
            if (side && /^(R_\d+|1HZ\d+V)$/.test(symbol)) {
                if (!target || target.side !== side)
                    setScannerWatch({
                        symbol,
                        side,
                        sampleSize: target?.sampleSize || 1000,
                        name: side === 'over' ? 'Over Punisher' : 'Under Punisher',
                    });
            } else if (!side && target && workspaceName && workspaceName !== target.name) {
                setScannerWatch(null);
            }
        };
        read();
        workspace?.addChangeListener(read);
        return () => workspace?.removeChangeListener(read);
    }, [target, running, workspaceName]);
    useEffect(() => {
        if (!target || !running) {
            setIssue('');
            setCheckedAt('');
            return;
        }
        let disposed = false;
        let api: Awaited<ReturnType<typeof generateDerivApiInstance>> | undefined;
        let listener: { unsubscribe: () => void } | undefined;
        let ready = false;
        let lastEpoch = 0;
        let lastUpdate = Date.now();
        let digits: number[] = [];
        const queued: Tick[] = [];
        setIssue('');
        setCheckedAt('');
        const warn = (message: string) => {
            if (!disposed) {
                setIssue(previous => previous || message);
                xmlScannerCycle.stop(message);
            }
        };
        const evaluate = () => {
            if (disposed) return;
            lastUpdate = Date.now();
            setCheckedAt(new Date().toLocaleTimeString());
            xmlScannerCycle.market(target.symbol, digits, lastEpoch);
            if (target.baselineCounts) {
                const counts = Array<number>(10).fill(0);
                digits.forEach(digit => counts[digit]++);
                if (risingScannerDigits(target.baselineCounts, counts, target.side, target.sampleSize).length >= 2)
                    scannerExitGuard.trigger();
            }
            if (!evaluateScan(digits, target.side, target.sampleSize).matches)
                setIssue(
                    previous =>
                        previous ||
                        'Market changed: the entry conditions no longer match. Stop the bot now and review any open trade.'
                );
        };
        const accept = (tick: Tick) => {
            if (disposed || tick.epoch <= lastEpoch) return;
            const digit = lastDigit(tick.quote, tick.pip_size);
            if (digit === null || !Number.isFinite(tick.epoch)) {
                warn('Live market data is invalid. Conditions cannot be verified. Stop the bot before continuing.');
                return;
            }
            if (lastEpoch && tick.epoch - lastEpoch > 6)
                warn(
                    'Live monitoring missed market ticks. Conditions cannot be verified. Stop the bot before continuing.'
                );
            lastEpoch = tick.epoch;
            digits = [...digits, digit].slice(-target.sampleSize);
            evaluate();
        };
        const connect = async () => {
            api = await generateDerivApiInstance({ publicOnly: true });
            if (disposed) {
                api.disconnect();
                return;
            }
            api.connection.addEventListener('close', () =>
                warn(
                    'Live monitoring disconnected. Conditions cannot be verified. Stop the bot and reconnect before continuing.'
                )
            );
            api.connection.addEventListener('error', () =>
                warn('Live monitoring is unavailable. Stop the bot and reconnect before continuing.')
            );
            listener = api.onMessage().subscribe(({ data }: { data: { tick?: Tick; error?: unknown } }) => {
                if (disposed) return;
                if (data.error) {
                    warn('Live monitoring is unavailable. Stop the bot and reconnect before continuing.');
                    return;
                }
                if (!data.tick) return;
                const tickSymbol = data.tick.symbol || data.tick.underlying_symbol;
                if (tickSymbol && tickSymbol !== target.symbol) return;
                if (!ready) queued.push(data.tick);
                else accept(data.tick);
            });
            const history = await api.send({
                ticks_history: target.symbol,
                style: 'ticks',
                end: 'latest',
                count: target.sampleSize,
                subscribe: 1,
            });
            if (disposed) return;
            if (!Array.isArray(history.history?.prices) || !Number.isInteger(history.pip_size))
                throw new Error('Missing market history');
            digits = (history.history.prices as number[])
                .map(price => lastDigit(price, history.pip_size))
                .filter((digit): digit is number => digit !== null)
                .slice(-target.sampleSize);
            if (digits.length !== target.sampleSize) throw new Error('Incomplete market history');
            const times = history.history.times as number[] | undefined;
            lastEpoch = times?.[times.length - 1] || 0;
            ready = true;
            evaluate();
            queued.forEach(accept);
            queued.length = 0;
        };
        void connect().catch(() => {
            warn('Live monitoring is unavailable. Stop the bot and reconnect before continuing.');
            listener?.unsubscribe();
            api?.disconnect();
        });
        const checkFreshness = () => {
            if (Date.now() - lastUpdate > 10000)
                warn('Live market data is delayed. Conditions cannot be verified. Stop the bot before continuing.');
        };
        const freshness = setInterval(checkFreshness, 1000);
        window.addEventListener('focus', checkFreshness);
        document.addEventListener('visibilitychange', checkFreshness);
        return () => {
            disposed = true;
            clearInterval(freshness);
            window.removeEventListener('focus', checkFreshness);
            document.removeEventListener('visibilitychange', checkFreshness);
            listener?.unsubscribe();
            api?.disconnect();
        };
    }, [target, running]);
    useEffect(() => {
        if (target && running && workspaceSymbol && workspaceSymbol !== target.symbol)
            setIssue(
                previous =>
                    previous ||
                    'The bot market was changed after the scanner match. Stop the bot and scan again before continuing.'
            );
    }, [target, running, workspaceSymbol]);
    if (!target || (!running && !protection.triggered)) return null;
    const protectionMessage = protection.triggered
        ? protection.phase === 'stopped'
            ? 'Market protection stopped the bot. Review the market before starting again.'
            : protection.phase === 'settling'
              ? 'Market protection activated. Waiting for the open trade to settle; recovery is limited to four consecutive losses total.'
              : 'Market protection activated. Recovery is active; the bot will stop after a win or four consecutive losses total.'
        : '';
    const warning = protectionMessage || issue;
    return (
        <aside
            ref={movable.ref}
            style={warning ? { ...movable.style, zIndex: 12000 } : movable.style}
            className={`scanner-trade-monitor${warning ? ' scanner-trade-monitor--warning' : ''}`}
            role={warning ? 'alert' : 'status'}
            aria-live={warning ? 'assertive' : 'polite'}
        >
            {movable.handle}
            <div>
                <strong>
                    {warning
                        ? protection.triggered
                            ? 'Market protection'
                            : 'Action required — stop trading'
                        : checkedAt
                          ? 'Live market monitor'
                          : 'Checking entry conditions…'}
                </strong>
                <p>
                    {target.name} · {target.symbol} · {target.side === 'over' ? 'Over' : 'Under'}
                </p>
                <p>
                    {warning ||
                        (checkedAt
                            ? `Conditions matched at ${checkedAt}. Monitoring each new tick.`
                            : 'Waiting for fresh market data; conditions have not yet been verified.')}
                </p>
                {!target.baselineCounts && <p>Load a fresh scanner match to enable automatic market protection.</p>}
                {warning && !protection.triggered && (
                    <p>
                        This warning stays until the bot stops. Stopping the bot may leave an open contract to settle
                        normally.
                    </p>
                )}
            </div>
            {running ? (
                <button onClick={() => run_panel.onStopButtonClick()}>Stop bot</button>
            ) : (
                <strong>Stopped</strong>
            )}
        </aside>
    );
});
export default ScannerTradeMonitor;
