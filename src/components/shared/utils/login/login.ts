import { affiliate_signup_url } from '@/utils/site-config';
import { startDerivLogin } from '@/utils/deriv-session';
export const redirectToLogin = (is_logged_in: boolean, _language: string, _has_params = true, _redirect_delay = 0) => {
    if (!is_logged_in) startDerivLogin();
};
export const redirectToSignUp = () => window.open(affiliate_signup_url, '_blank', 'noopener,noreferrer');
export const loginUrl = (_options: { language: string }) => '/api/auth/login';
