import { useEffect } from 'react';
import { observer } from 'mobx-react-lite';
import { api_base } from '@/external/bot-skeleton';
import { useApiBase } from '@/hooks/useApiBase';
import { useStore } from '@/hooks/useStore';
import { useTranslations } from '@deriv-com/translations';

const CoreStoreProvider: React.FC<{ children: React.ReactNode }> = observer(({ children }) => {
    const { client, common } = useStore() ?? {};
    const { accountList, activeLoginid, isAuthorized, connectionStatus } = useApiBase();
    const { currentLang } = useTranslations();
    useEffect(() => {
        common?.setCurrentLanguage(currentLang);
    }, [common, currentLang]);
    useEffect(() => {
        if (!client) return;
        client.setAccountList(accountList);
        client.setLoginId(activeLoginid);
        client.setIsLoggedIn(isAuthorized);
        const account = accountList.find(item => item.loginid === activeLoginid);
        if (account) client.setCurrency(account.currency);
        const balance = (api_base.account_info as { balance?: number }).balance;
        if (balance !== undefined) client.setBalance(String(balance));
    }, [client, accountList, activeLoginid, isAuthorized]);
    useEffect(() => {
        if (!client) return;
        const subscription = api_base.api?.onMessage().subscribe(({ data }: any) => {
            if (data.msg_type === 'balance' && !data.error) {
                client.setBalance(String(data.balance.balance));
                client.setCurrency(data.balance.currency);
            }
        });
        return () => subscription?.unsubscribe();
    }, [client, connectionStatus, isAuthorized]);
    return <>{children}</>;
});
export default CoreStoreProvider;
