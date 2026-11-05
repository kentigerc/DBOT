import '../public-path';
import { lazy, Suspense } from 'react';
import { createBrowserRouter, createRoutesFromElements, Route, RouterProvider } from 'react-router-dom';
import { useOfflineDetection } from '@/hooks/useOfflineDetection';
import './app-root.scss';
const Landing = lazy(() => import('../pages/landing'));
const TradingLayout = lazy(() => import('./TradingLayout'));
const AppRoot = lazy(() => import('./app-root'));
const CallbackPage = lazy(() => import('../pages/callback'));
const Endpoint = lazy(() => import('../pages/endpoint'));
const FreeBots = lazy(() => import('../pages/free-bots'));
const Admin = lazy(() => import('../pages/admin'));
const AnalysisTool = lazy(() => import('../pages/analysis-tool'));
const SuspenseWrapper = ({ children }: { children: React.ReactNode }) => {
    const { isOnline } = useOfflineDetection();
    return (
        <Suspense
            fallback={
                <div className='app-root' role='status'>
                    {isOnline ? 'Loading NetoAcademy…' : 'Loading offline dashboard…'}
                </div>
            }
        >
            {children}
        </Suspense>
    );
};
const router = createBrowserRouter(
    createRoutesFromElements(
        <>
            <Route
                path='/'
                element={
                    <SuspenseWrapper>
                        <Landing />
                    </SuspenseWrapper>
                }
            />
            <Route
                path='/callback'
                element={
                    <SuspenseWrapper>
                        <CallbackPage />
                    </SuspenseWrapper>
                }
            />
            <Route
                element={
                    <SuspenseWrapper>
                        <TradingLayout />
                    </SuspenseWrapper>
                }
            >
                <Route path='/platform' element={<AppRoot />} />
                <Route path='/endpoint' element={<Endpoint />} />
                <Route path='/free-bots' element={<FreeBots />} />
                <Route path='/analysis-tool' element={<AnalysisTool />} />
                <Route path='/admin' element={<Admin />} />
            </Route>
        </>
    )
);
export default function App() {
    return <RouterProvider router={router} />;
}
