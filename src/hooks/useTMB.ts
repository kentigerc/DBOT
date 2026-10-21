import { startDerivLogin } from '@/utils/deriv-session';

declare global {
    interface Window {
        is_tmb_enabled?: boolean;
    }
}
// The Deriv-owned TMB session is not NetoAcademy's OAuth session.
const useTMB = () => ({
    handleLogout: () => undefined,
    isOAuth2Enabled: true,
    is_tmb_enabled: false,
    onRenderTMBCheck: async () => startDerivLogin(),
    isTmbEnabled: async () => false,
    isInitialized: true,
    isTmbCheckComplete: true,
});
export default useTMB;
