import { localize } from '@deriv-com/translations';
import { config } from '../constants/config';

// TODO: use-shared-functions - These functions are duplicates of trader ones, export and use these instead.
export const getContractTypeName = contract => {
    const { opposites } = config();
    let name = localize('Unknown');

    Object.keys(opposites).forEach(opposites_name => {
        const contract_type_objs = opposites[opposites_name];

        contract_type_objs.forEach(contract_type_obj => {
            const contract_type_names = Object.entries(contract_type_obj)[0]; // ['CALL', 'Rise']

            if (contract_type_names[0] === contract?.contract_type) {
                // Extra check for CALL & PUT types to distinguish Rise/Fall & Higher/Lower.
                if (['CALL', 'PUT'].includes(contract_type_names[0])) {
                    // New API receipts and restored journals may not include a shortcode yet.
                    // Use known contract metadata without inventing a broker shortcode.
                    let req_opposite_name;
                    if (typeof contract.shortcode === 'string' && contract.shortcode) {
                        const shortcode_suffix = contract.shortcode.split('_').slice(-2)[0];
                        req_opposite_name = /^S0P$/.test(shortcode_suffix) ? 'CALLPUT' : 'HIGHERLOWER';
                    } else if (contract.trade_type === 'higherlower' || contract.barrier != null) {
                        req_opposite_name = 'HIGHERLOWER';
                    } else if (contract.trade_type === 'risefall') {
                        req_opposite_name = 'CALLPUT';
                    } else return;

                    if (opposites_name !== req_opposite_name) {
                        return;
                    }
                }

                name = contract_type_names[1];
            }
        });
    });

    return name;
};
