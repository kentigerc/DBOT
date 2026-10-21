// Known third-party XML names with the same inputs as the standard blocks.
// Do not discard unknown blocks or guess missing risk-management behavior.
export function normalizeImportedBlocks(xml) {
    const aliases = { apollo_purchase: 'purchase', btnotify: 'notify' };
    for (const block of xml.querySelectorAll('block')) {
        const type = block.getAttribute('type');
        if (!aliases[type]) continue;
        const fields = [...block.children]
            .filter(child => child.tagName.toLowerCase() === 'field')
            .map(child => child.getAttribute('name'));
        const expected = type === 'apollo_purchase' ? ['PURCHASE_LIST'] : ['NOTIFICATION_TYPE', 'NOTIFICATION_SOUND'];
        const values = [...block.children]
            .filter(child => child.tagName.toLowerCase() === 'value')
            .map(child => child.getAttribute('name'));
        if (
            fields.some(field => !expected.includes(field)) ||
            values.some(value => type !== 'btnotify' || value !== 'MESSAGE') ||
            [...block.children].some(
                child =>
                    ['mutation', 'statement'].includes(child.tagName.toLowerCase()) ||
                    (type === 'apollo_purchase' && child.tagName.toLowerCase() === 'next')
            )
        ) {
            throw new Error(`This bot uses an unsupported variant of ${type}.`);
        }
        block.setAttribute('type', aliases[type]);
    }
    return xml;
}
