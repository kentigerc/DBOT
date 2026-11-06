import { useCallback, useEffect, useMemo, useState } from 'react';
import { NewApiTransport } from '@/external/bot-skeleton/services/api/new-api-transport';
import { startApiKeepalive } from '@/utils/api-keepalive';
import DerivAPIBasic from '@deriv/deriv-api/dist/DerivAPIBasic';
import { ChartTitle, SmartChart, setSmartChartsPublicPath } from '@deriv/deriv-charts';
import { useDevice } from '@deriv-com/ui';
import ToolbarWidgets from '@/pages/chart/toolbar-widgets';
import '@deriv/deriv-charts/dist/smartcharts.css';

setSmartChartsPublicPath('/js/smartcharts/');

type Request = Record<string, unknown>;
type Response = { subscription?: { id: string }; error?: { message: string }; [key: string]: unknown };

// A separate public connection keeps the landing chart independent of account and bot sessions.
export default function LiveChart({ darkMode }: { darkMode: boolean }) {
    const [api, setApi] = useState<DerivAPIBasic | null>(null);
    const [connected, setConnected] = useState(false);
    const [error, setError] = useState('');
    const [interactive, setInteractive] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const [symbol, setSymbol] = useState('R_100');
    const [chartType, setChartType] = useState('line');
    const [granularity, setGranularity] = useState(0);
    const { isDesktop, isMobile } = useDevice();
    const subscriptions = useMemo(() => new Map<string, { unsubscribe: () => void }>(), [attempt]);
    useEffect(() => {
        let active = true;
        const url = new URL('/api/socket', window.location.origin);
        url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const connection = new NewApiTransport(url.toString());
        const client = new DerivAPIBasic({ connection });
        const stopKeepalive = startApiKeepalive(client);
        const open = () => {
            if (active) {
                setConnected(true);
                setError('');
            }
        };
        const close = () => {
            if (active) {
                setConnected(false);
                setInteractive(false);
                setError('Market data disconnected. Reconnect to resume the live chart.');
            }
        };
        connection.addEventListener('open', open);
        connection.addEventListener('close', close);
        connection.addEventListener('error', close);
        setApi(client);
        return () => {
            active = false;
            connection.removeEventListener('open', open);
            connection.removeEventListener('close', close);
            connection.removeEventListener('error', close);
            subscriptions.forEach(subscription => subscription.unsubscribe());
            subscriptions.clear();
            stopKeepalive();
            client.disconnect();
        };
    }, [attempt, subscriptions]);
    const requestAPI = useCallback(
        async (request: Request) => {
            if (!api) throw new Error('Chart is connecting.');
            const response = await api.send(request);
            if (response.error) throw response;
            return response;
        },
        [api]
    );
    const requestForgetStream = useCallback(
        (id: string) => {
            subscriptions.get(id)?.unsubscribe();
            subscriptions.delete(id);
            if (api?.connection.readyState === 1) void api.forget(id).catch(() => {});
        },
        [api, subscriptions]
    );
    const requestSubscribe = useCallback(
        async (request: Request, callback: (response: Response) => void) => {
            const response = await requestAPI(request);
            const id = response.subscription?.id;
            if (api?.connection.readyState !== 1) return response;
            if (id && request.subscribe === 1) {
                subscriptions.set(
                    id,
                    api!.onMessage().subscribe(({ data }: { data: Response }) => {
                        if (data.subscription?.id === id) callback(data);
                    })
                );
            }
            callback(response);
            return response;
        },
        [api, requestAPI, subscriptions]
    );
    return (
        <div className='nl-smart-chart'>
            <div className='nl-smart-chart__interaction'>
                <span>{interactive ? 'Chart controls enabled' : 'Live chart · Scroll to explore'}</span>
                <button
                    type='button'
                    disabled={!connected}
                    aria-pressed={interactive}
                    onClick={() => setInteractive(value => !value)}
                >
                    {interactive ? 'Return to page scrolling' : 'Enable chart controls'}
                </button>
            </div>

            {error ? (
                <div className='nl-smart-chart__status' role='alert'>
                    <p>{error}</p>
                    <button
                        type='button'
                        onClick={() => {
                            setError('');
                            setConnected(false);
                            setAttempt(value => value + 1);
                        }}
                    >
                        Reconnect chart
                    </button>
                </div>
            ) : !connected ? (
                <div className='nl-smart-chart__status' role='status'>
                    Connecting live chart…
                </div>
            ) : null}
            <div
                className={`nl-smart-chart__canvas${interactive ? '' : ' nl-smart-chart__canvas--preview'}`}
                {...(!interactive ? { inert: '' } : {})}
            >
                {api && connected && (
                    <SmartChart
                        id='neto-landing'
                        barriers={[]}
                        showLastDigitStats={false}
                        chartControlsWidgets={null}
                        enabledChartFooter={false}
                        toolbarWidget={() => (
                            <ToolbarWidgets
                                updateChartType={setChartType}
                                updateGranularity={setGranularity}
                                position={isDesktop ? 'top' : 'bottom'}
                                isDesktop={isDesktop}
                            />
                        )}
                        chartType={chartType}
                        granularity={granularity}
                        symbol={symbol}
                        settings={{
                            assetInformation: false,
                            countdown: true,
                            isHighestLowestMarkerEnabled: false,
                            language: 'en',
                            position: 'bottom',
                            theme: darkMode ? 'dark' : 'light',
                        }}
                        isMobile={isMobile}
                        enabledNavigationWidget={isDesktop}
                        requestAPI={requestAPI}
                        requestSubscribe={requestSubscribe}
                        requestForgetStream={requestForgetStream}
                        requestForget={() => subscriptions.forEach((_, id) => requestForgetStream(id))}
                        topWidgets={() => <ChartTitle onChange={setSymbol} />}
                        isConnectionOpened={connected}
                        isLive
                        leftMargin={80}
                    />
                )}
            </div>
            {!interactive && <div className='nl-smart-chart__scroll-surface' aria-hidden='true' />}
        </div>
    );
}
