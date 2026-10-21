export default class AccountLimits {
    constructor(store) {
        this.ws = store.ws;
    }
    // eslint-disable-next-line default-param-last
    getStakePayoutLimits() {
        // The new API has no landing_company_details endpoint. There are no
        // provider limits to display here; proposal/buy perform server validation.
        return Promise.resolve({});
    }
}
