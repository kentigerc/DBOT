// Check browser compatibility and prevent service worker issues
const userAgent = navigator.userAgent.toLowerCase();
const isFirefox = userAgent.includes('firefox');
const isSafari = userAgent.includes('safari') && !userAgent.includes('chrome');
const shouldSkipSW = isFirefox || isSafari;

if (shouldSkipSW) {
    const browserName = isFirefox ? 'Firefox' : 'Safari';
    console.log(
        `[HTML] ${browserName} detected - preventing service worker registration to avoid chunk loading issues`
    );

    // Cleanup any existing service workers
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker
            .getRegistrations()
            .then(registrations => {
                registrations.forEach(registration => {
                    console.log(`[HTML] Unregistering existing SW for ${browserName}:`, registration.scope);
                    registration.unregister();
                });
            })
            .catch(error => {
                console.error('[HTML] Failed to cleanup service workers:', error);
            });
    }
}

// Check online/offline status
console.log('[HTML] Online status:', navigator.onLine);
window.addEventListener('online', () => {
    console.log('[HTML] Back online');
});
window.addEventListener('offline', () => {
    console.log('[HTML] Gone offline');
});

// Listen for service worker messages if registered by PWA utils (non-problematic browsers only)
if ('serviceWorker' in navigator && !shouldSkipSW) {
    navigator.serviceWorker.addEventListener('message', event => {
        console.log('[HTML] Message from service worker:', event.data);
    });
}
