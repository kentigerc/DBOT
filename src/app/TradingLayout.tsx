import { lazy } from 'react';
import RoutePromptDialog from '@/components/route-prompt-dialog';
import { StoreProvider } from '@/hooks/useStore';
import { initializeI18n, TranslationProvider } from '@deriv-com/translations';
import CoreStoreProvider from './CoreStoreProvider';
const Layout = lazy(() => import('../components/layout'));
const { TRANSLATIONS_CDN_URL, R2_PROJECT_NAME, CROWDIN_BRANCH_NAME } = process.env;
const i18nInstance = initializeI18n({
    cdnUrl: `${TRANSLATIONS_CDN_URL}/${R2_PROJECT_NAME}/${CROWDIN_BRANCH_NAME}`,
});

export default function TradingLayout() {
    return (
        <TranslationProvider defaultLang='EN' i18nInstance={i18nInstance}>
            <StoreProvider>
                <RoutePromptDialog />
                <CoreStoreProvider>
                    <Layout />
                </CoreStoreProvider>
            </StoreProvider>
        </TranslationProvider>
    );
}
