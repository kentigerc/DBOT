import configuration from '../../config/netoacademy.json';

export const website_domain = new URL(configuration.origin).hostname;
export const website_name = 'Deriv';
// Keep the provider brand separate from our public site identity.
export const site_name = 'NetoAcademy';
export const site_origin = configuration.origin;
// New developer-dashboard registration. These are public identifiers, not secrets.
export const deriv_application = Object.freeze({
    app_id: configuration.appId,
    redirect_uri: `${site_origin}${configuration.callbackPath}`,
    homepage_url: site_origin,
});
export const affiliate_signup_url = configuration.affiliateSignupUrl;
export const default_title = site_name;
export const TRACKING_STATUS_KEY = 'tracking_status';
