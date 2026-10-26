import { useEffect, useState, useSyncExternalStore } from 'react';
import { observer } from 'mobx-react-lite';
import { generateDerivApiInstance } from '@/external/bot-skeleton/services/api/appId';
import { useStore } from '@/hooks/useStore';
import { lastDigit } from '@/pages/digit-analysis/digits';
import { risingScannerDigits, scannerExitGuard } from '@/utils/scanner-exit-guard';
import { getScannerWatch, setScannerWatch, subscribeScannerWatch } from '@/utils/scanner-watch';
import { xmlScannerCycle } from '@/utils/xml-scanner-cycle';

type Tick = { quote: number; epoch: number; pip_size: number; symbol?: string; underlying_symbol?: string };
const ScannerTradeMonitor = observer(() => {
    const { run_panel } = useStore();
    const target = useSyncExternalStore(subscribeScannerWatch, getScannerWatch);
    const running = run_panel.is_running;
    const workspaceName = (window as unknown as { Blockly?: { xmlValues?: { file_name?: string } } }).Blockly?.xmlValues
        ?.file_name;
    const [workspaceSymbol, setWorkspaceSymbol] = useState('');
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
        if (!target || !running) return;
        let disposed = false;
        let api: Awaited<ReturnType<typeof generateDerivApiInstance>> | undefined;
        let listener: { unsubscribe: () => void } | undefined;
        let ready = false;
        let lastEpoch = 0;
        let lastUpdate = Date.now();
        let digits: number[] = [];
        const queued: Tick[] = [];
        const warn = (message: string) => {
            if (!disposed) {
                xmlScannerCycle.stop(message);
            }
        };
        const evaluate = () => {
            if (disposed) return;
            lastUpdate = Date.now();
            if (xmlScannerCycle.getSnapshot().phase === 'switching') return;
            xmlScannerCycle.market(target.symbol, digits, lastEpoch);
            if (target.baselineCounts) {
                const counts = Array<number>(10).fill(0);
                digits.forEach(digit => counts[digit]++);
                if (risingScannerDigits(target.baselineCounts, counts, target.side, target.sampleSize).length >= 2)
                    scannerExitGuard.trigger();
            }
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
        // Auto changes the live engine market without restarting XML. Its own
        // purchase gate and scanner link are authoritative during that handoff.
        if (
            !xmlScannerCycle.getSnapshot().enabled &&
            target &&
            running &&
            workspaceSymbol &&
            workspaceSymbol !== target.symbol
        )
            xmlScannerCycle.stop('The bot market was changed after the scanner match. Start a fresh scan.');
    }, [target, running, workspaceSymbol]);
    // Monitoring and automatic protection continue without any floating warning UI.
    return null;
});
export default ScannerTradeMonitor;
