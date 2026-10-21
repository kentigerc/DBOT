import { Link } from 'react-router-dom';
import { site_name } from '@/utils/site-config';
import './app-logo.scss';

export const AppLogo = () => {
    return (
        <Link className='app-header__logo' to='/' aria-label={`${site_name} home`}>
            {site_name}
        </Link>
    );
};
