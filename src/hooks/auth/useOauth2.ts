import RootStore from '@/stores/root-store';
import { logoutDerivSession, startDerivLogin } from '@/utils/deriv-session';

// Keep the existing hook name for components while routing all auth through our server.
export const useOauth2 = (_options: { handleLogout?: () => Promise<void>; client?: RootStore['client'] } = {}) => ({
    oAuthLogout: logoutDerivSession,
    retriggerOAuth2Login: async () => startDerivLogin(),
    isSingleLoggingIn: false,
    isOAuth2Enabled: true,
});
