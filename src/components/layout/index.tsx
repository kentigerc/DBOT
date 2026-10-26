import { observer } from 'mobx-react-lite';
import { Outlet } from 'react-router-dom';
import PWAUpdateNotification from '@/components/pwa-update-notification';
import { useDevice } from '@deriv-com/ui';
import UsageTracker from '../usage-tracker';
import Footer from './footer';
import AppHeader from './header';
import Body from './main-body';
import './layout.scss';

const Layout = observer(() => {
    const { isDesktop } = useDevice();
    return (
        <div className={`layout${isDesktop ? ' responsive' : ''}`}>
            <AppHeader />
            <UsageTracker />
            <Body>
                <Outlet />
            </Body>
            {isDesktop && <Footer />}
            <PWAUpdateNotification />
        </div>
    );
});
export default Layout;
