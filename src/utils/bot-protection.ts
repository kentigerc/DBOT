// Browser-level export restrictions. Strategies sent to a browser are not secret.
export const HOSTED_BOT_MARKER = 'netoacademy:hosted-bot:';
export const HOSTED_BOT_NOTICE =
    'This NetoAcademy bot can run on this site, but saving or exporting its strategy is disabled.';

export function isProtectedBotXml(value: string | Element | null | undefined): boolean {
    if (!value) return false;
    const xml =
        typeof value === 'string' ? new DOMParser().parseFromString(value, 'application/xml').documentElement : value;
    return (
        xml.getAttribute('neto_protected') === 'true' ||
        Array.from(xml.querySelectorAll('data')).some(data => data.textContent?.startsWith(HOSTED_BOT_MARKER))
    );
}
export function isProtectedBotWorkspace(workspace: any = (window.Blockly as any)?.derivWorkspace): boolean {
    return (
        !!workspace?.netoHostedBot ||
        !!workspace?.getAllBlocks(false).some((block: { data?: string }) => block.data?.startsWith(HOSTED_BOT_MARKER))
    );
}
export function installBotProtection(blockly: any = window.Blockly) {
    const xml = blockly?.Xml;
    if (!xml || xml.netoProtectionInstalled) return;
    const serialize = xml.workspaceToDom;
    const replace = xml.clearWorkspaceAndLoadFromXml;
    xml.workspaceToDom = function (workspace: typeof blockly.derivWorkspace, ...args: unknown[]) {
        const dom = serialize.call(this, workspace, ...args);
        if (isProtectedBotWorkspace(workspace)) dom.setAttribute('neto_protected', 'true');
        return dom;
    };
    xml.clearWorkspaceAndLoadFromXml = function (
        dom: Element,
        workspace: typeof blockly.derivWorkspace,
        ...args: unknown[]
    ) {
        const result = replace.call(this, dom, workspace, ...args);
        workspace.netoHostedBot = isProtectedBotXml(dom);
        return result;
    };
    xml.netoProtectionInstalled = true;
}

let protectedMemory: { xml: string; name: string; id: string } | undefined;
export const getProtectedBotMemory = () => protectedMemory;
export function rememberProtectedBot(workspace: any, name: string) {
    protectedMemory = isProtectedBotWorkspace(workspace)
        ? {
              xml: (window.Blockly as any).Xml.domToText((window.Blockly as any).Xml.workspaceToDom(workspace)),
              name,
              id: workspace.current_strategy_id,
          }
        : undefined;
}
